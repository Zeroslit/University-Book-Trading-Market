// 认证服务：注册 / 登录 / 微信一键登录（模拟）/ 刷新令牌
import { AppError, ERR } from '../../lib/errors.js';
import { encrypt, hmac, hashPassword, verifyPassword, randomToken } from '../../lib/crypto.js';
import { maskStudentNo, maskPhone, maskName } from '../../lib/mask.js';
import { q1, run, withTransaction } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { signTokens, verifyToken } from '../../middleware/auth.js';
import { smsService } from '../../services/sms.service.js';
import { notifyService } from '../../services/notify.service.js';
import { config } from '../../config/index.js';

export const authService = {
  async sendSms({ phone, scene, ip }) {
    return smsService.sendCode(phone, scene, ip);
  },

  // 注册：学校（下拉选择，禁止手填）-> 学号 -> 手机号验证码 -> 密码
  async register({ schoolId, studentNo, phone, code, password, nickname, realName = null }) {
    await smsService.verifyCode(phone, 'register', code);

    const school = await q1(pool, 'SELECT id, name, status, require_student_verification FROM schools WHERE id = ?', [schoolId]);
    if (!school) throw new AppError(ERR.NOT_FOUND, '学校不存在，可通过「申请开通学校」提交申请');
    if (school.status !== 'active') throw new AppError(ERR.CONFLICT, '该学校尚未开通平台服务，请先申请开通');

    const phoneHash = hmac(phone);
    const existedPhone = await q1(pool, 'SELECT id FROM users WHERE phone_hash = ?', [phoneHash]);
    if (existedPhone) throw new AppError(ERR.PHONE_EXISTS, '该手机号已注册，请直接登录');
    const existedStudent = await q1(pool, 'SELECT id FROM users WHERE school_id = ? AND student_no = ?', [schoolId, studentNo]);
    if (existedStudent) throw new AppError(ERR.STUDENT_NO_EXISTS, '该学号在本校已注册');

    const passwordHash = await hashPassword(password);
    const created = await withTransaction(async (conn) => {
      const result = await run(
        conn,
        `INSERT INTO users (school_id, student_no, student_no_mask, phone_enc, phone_last4, phone_hash, password_hash,
           nickname, real_name_enc, real_name_mask, role, status, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'student', 'active', 'unverified')`,
        [schoolId, studentNo, maskStudentNo(studentNo), encrypt(phone), phone.slice(-4), phoneHash, passwordHash,
          nickname || `${maskPhone(phone)}同学`, realName ? encrypt(realName) : null, realName ? maskName(realName) : null],
      );
      await run(conn, 'INSERT IGNORE INTO wallet_accounts (user_id, school_id) VALUES (?, ?)', [result.insertId, schoolId]);
      return result.insertId;
    });

    await notifyService.notify(created, {
      schoolId, type: 'verification', title: '欢迎加入',
      content: school.require_student_verification
        ? '注册成功！完成学生认证后即可发布教材与交易'
        : '注册成功！你现在就可以发布教材与交易了',
    });

    const user = await this.getUserForToken(created);
    return { user: this.toProfile(user), ...signTokens(user), needVerification: school.require_student_verification === 1 };
  },

  async login({ phone, password }) {
    const user = await q1(pool, 'SELECT * FROM users WHERE phone_hash = ? AND deleted_at IS NULL', [hmac(phone)]);
    if (!user) throw new AppError(ERR.PASSWORD_ERROR, '手机号或密码不正确');
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) throw new AppError(ERR.PASSWORD_ERROR, '手机号或密码不正确');
    if (user.banned_permanently) {
      throw new AppError(ERR.LOGIN_BANNED, '账号已被永久封禁，可在「我的-违规记录」提交申诉', { appealAvailable: true });
    }
    if (user.login_ban_until && new Date(user.login_ban_until) > new Date()) {
      throw new AppError(ERR.LOGIN_BANNED, `账号禁止登录至 ${new Date(user.login_ban_until).toLocaleString('zh-CN')}`, {
        until: user.login_ban_until, appealAvailable: true,
      });
    }
    await run(pool, 'UPDATE users SET last_login_at = NOW(3) WHERE id = ?', [user.id]);
    return { user: this.toProfile(user), ...signTokens(user) };
  },

  // 微信一键登录（一期为模拟：code 直接换 mock openid，二期替换为真实 code2Session）
  async loginWechat({ code }) {
    const openid = config.wechat.mock ? `mock_${code}` : await this.exchangeWechatCode(code);
    const user = await q1(pool, 'SELECT * FROM users WHERE wechat_openid = ? AND deleted_at IS NULL', [openid]);
    if (!user) {
      throw new AppError(ERR.VALIDATION_ERROR, '该微信尚未绑定平台账号，请先用手机号登录后在个人中心绑定微信', { openid });
    }
    await run(pool, 'UPDATE users SET last_login_at = NOW(3) WHERE id = ?', [user.id]);
    return { user: this.toProfile(user), ...signTokens(user) };
  },

  async exchangeWechatCode() {
    // 二期：调用 https://api.weixin.qq.com/sns/jscode2session
    throw new AppError(ERR.DEPENDENCY_UNAVAILABLE, '微信真实通道未接入（一期为模拟实现）');
  },

  async bindWechat({ userId, code }) {
    const openid = config.wechat.mock ? `mock_${code}` : await this.exchangeWechatCode(code);
    const existed = await q1(pool, 'SELECT id FROM users WHERE wechat_openid = ?', [openid]);
    if (existed && Number(existed.id) !== Number(userId)) throw new AppError(ERR.CONFLICT, '该微信已绑定其他账号');
    await run(pool, 'UPDATE users SET wechat_openid = ? WHERE id = ?', [openid, userId]);
    return { bound: true, openid: `***${openid.slice(-4)}` };
  },

  async refresh({ refreshToken }) {
    const payload = verifyToken(refreshToken);
    if (payload.type !== 'refresh') throw new AppError(ERR.TOKEN_INVALID, '请传入 refreshToken');
    const user = await this.getUserForToken(payload.sub);
    return signTokens(user);
  },

  async changePassword({ userId, phone, code, newPassword }) {
    await smsService.verifyCode(phone, 'reset', code);
    const user = await q1(pool, 'SELECT id FROM users WHERE id = ? AND phone_hash = ?', [userId, hmac(phone)]);
    if (!user) throw new AppError(ERR.VALIDATION_ERROR, '手机号与当前账号不匹配');
    await run(pool, 'UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), userId]);
    return { updated: true };
  },

  async getUserForToken(userId) {
    const user = await q1(pool, 'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
    if (!user) throw new AppError(ERR.UNAUTHORIZED, '账号不存在');
    return user;
  },

  // 对外输出：一律脱敏，禁止返回密文手机号/学号
  toProfile(user) {
    return {
      id: user.id,
      schoolId: user.school_id,
      role: user.role,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      studentNoMask: user.student_no_mask,
      phoneMask: maskPhone(`0${user.phone_last4}`).replace(/^0/, ''),
      phoneLast4: user.phone_last4,
      verificationStatus: user.verification_status,
      creditScore: user.credit_score,
      status: user.status,
      muteUntil: user.mute_until,
      tradeBanUntil: user.trade_ban_until,
      bannedPermanently: Boolean(user.banned_permanently),
    };
  },

  newRefreshTokenHint() {
    return randomToken(8);
  },
};
