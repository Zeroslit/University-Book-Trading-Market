// 演示版：账号体系（注册/登录/认证/收款绑定/学校/通知）
import { table, insert, filter, nowIso, isoAfter, generateNo, configValue } from '../store.js';
import { AppError, ERR, maskName, maskBankCard, maskEmail, maskStudentNo } from '../vendor.js';
import { walletAccount, notify, audit, creditPermissions, creditTier } from '../rules.js';
import { check as wordCheck } from '../words.js';
import {
  paged, pageOf, slicePage, toAuthUser, toPublicSchool, schoolOf, phoneMaskOf, requireFields,
} from './util.js';

const DEMO_USERID = 1;

function issueTokens(user) {
  return { accessToken: `demo-token.${user.id}.${Date.now()}`, refreshToken: `demo-refresh.${user.id}`, user: toAuthUser(user) };
}

export function registerAccountRoutes(route) {
  // ---------------- 认证 ----------------
  route('POST', '/auth/sms/send', (ctx) => {
    const phone = ctx.body.phone;
    if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) throw new AppError(ERR.VALIDATION_ERROR, '手机号格式不正确');
    insert('sms_logs', {
      phone_last4: String(phone).slice(-4), scene: ctx.body.scene || 'register',
      code: '123456', status: 'sent', created_at: nowIso(),
    });
    return { sent: true, expiresIn: 300, devCode: '123456' };
  }, { public: true, schoolScope: false, message: '验证码已发送（演示环境固定 123456）' });

  route('POST', '/auth/register', (ctx) => {
    const { schoolId, studentNo, phone, code, password, nickname, realName } = ctx.body;
    requireFields(ctx.body, ['schoolId', 'studentNo', 'phone', 'code', 'password']);
    const school = schoolOf(Number(schoolId));
    if (school.status !== 'active') throw new AppError(ERR.VALIDATION_ERROR, '该学校暂未开通，请先申请开通');
    if (String(password).length < 8) throw new AppError(ERR.VALIDATION_ERROR, '密码至少 8 位');
    if (!/^\d{6}$/.test(String(code))) throw new AppError(ERR.SMS_CODE_INVALID, '短信验证码格式不正确');
    if (filter('users', (u) => u.phone === String(phone)).length) {
      throw new AppError(ERR.PHONE_EXISTS, '该手机号已注册，请直接登录或使用其他号码');
    }
    if (filter('users', (u) => Number(u.school_id) === Number(schoolId) && u.student_no === String(studentNo)).length) {
      throw new AppError(ERR.STUDENT_NO_EXISTS, '该学号在本校已注册，请核对后重试');
    }
    const bounds = configValue('credit.bounds', schoolId);
    const user = insert('users', {
      school_id: Number(schoolId), student_no: String(studentNo), student_no_mask: maskStudentNo(studentNo),
      phone_last4: String(phone).slice(-4), phone: String(phone),
      nickname: nickname || `同学${String(studentNo).slice(-4)}`, avatar_url: null,
      bio: null, real_name_mask: realName ? maskName(realName) : null,
      role: 'student', status: 'active', verification_status: 'unverified',
      credit_score: Number(bounds.max), mute_until: null, trade_ban_until: null, login_ban_until: null,
      banned_permanently: 0, last_login_at: nowIso(), created_at: nowIso(), updated_at: nowIso(), deleted_at: null,
    });
    walletAccount(user.id);
    audit({ schoolId: Number(schoolId), actorId: user.id, actorRole: 'student', action: 'user.register', targetType: 'user', targetId: user.id });
    notify(user.id, {
      schoolId: Number(schoolId), type: 'system', title: '欢迎加入校园教材循环',
      content: '请先在「学生认证」提交学生证照片或校园邮箱，认证通过后即可发布教材并交易。',
    });
    return issueTokens(user);
  }, { public: true, schoolScope: false, message: '注册成功' });

  route('POST', '/auth/login', (ctx) => {
    const { phone } = ctx.body;
    requireFields(ctx.body, ['phone', 'password']);
    const user = table('users').find((u) => u.phone === String(phone) && !u.deleted_at);
    if (!user) throw new AppError(ERR.PASSWORD_ERROR, '手机号或密码错误（演示环境任意密码均可登录已有账号）');
    if (user.banned_permanently) throw new AppError(ERR.LOGIN_BANNED, '账号已被永久封禁，如有疑问可提交申诉');
    user.last_login_at = nowIso();
    return issueTokens(user);
  }, { public: true, schoolScope: false, message: '登录成功' });

  route('POST', '/auth/login/wechat', () => {
    const user = table('users').find((u) => Number(u.id) === DEMO_USERID);
    if (!user) throw new AppError(ERR.USER_NOT_FOUND, '演示账号缺失');
    return issueTokens(user);
  }, { public: true, schoolScope: false, message: '微信授权成功（模拟）' });

  route('POST', '/auth/password/reset', (ctx) => {
    requireFields(ctx.body, ['phone', 'code', 'password']);
    const user = table('users').find((u) => u.phone === String(ctx.body.phone));
    if (!user) throw new AppError(ERR.USER_NOT_FOUND, '该手机号未注册');
    return { reset: true };
  }, { public: true, schoolScope: false, message: '密码已重置' });

  route('POST', '/auth/logout', () => ({ ok: true }), { schoolScope: false });

  route('GET', '/auth/me', (ctx) => {
    const user = ctx.user;
    const school = user.school_id ? table('schools').find((s) => Number(s.id) === Number(user.school_id)) : null;
    const wallet = walletAccount(user.id);
    return {
      user: toAuthUser(user),
      school: school ? toPublicSchool(school) : null,
      wallet: { balanceCents: Number(wallet.balance_cents), frozenCents: Number(wallet.frozen_cents) },
    };
  }, { schoolScope: false });

  // ---------------- 学校 ----------------
  route('GET', '/schools', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query, { defaultSize: 20, maxSize: 50 });
    const keyword = ctx.query.keyword || '';
    const rows = table('schools')
      .filter((s) => s.status === 'active')
      .filter((s) => (!keyword || s.name.includes(keyword)))
      .filter((s) => (!ctx.query.province || s.province === ctx.query.province))
      .filter((s) => (!ctx.query.city || s.city === ctx.query.city))
      .sort((a, b) => `${a.province}${a.city}${a.name}`.localeCompare(`${b.province}${b.city}${b.name}`, 'zh-CN'));
    const list = rows.slice(offset, offset + pageSize).map((s) => ({
      id: Number(s.id), name: s.name, province: s.province, city: s.city, code: s.code, status: s.status,
    }));
    return paged(list, rows.length, page, pageSize);
  }, { public: true, schoolScope: false });

  route('GET', '/schools/provinces', () => {
    const grouped = {};
    for (const s of table('schools').filter((x) => x.status === 'active')) {
      grouped[s.province] = grouped[s.province] || { province: s.province, cities: [] };
      const city = grouped[s.province].cities.find((c) => c.city === s.city);
      if (city) city.total += 1;
      else grouped[s.province].cities.push({ city: s.city, total: 1 });
    }
    return Object.values(grouped);
  }, { public: true, schoolScope: false });

  route('GET', '/schools/applications/list', () => table('school_applications')
    .filter((a) => a.status === 'pending')
    .map((a) => ({
      id: Number(a.id), school_name: a.school_name, province: a.province, city: a.city,
      applicant_name: a.applicant_name, applicant_phone_last4: a.applicant_phone_last4,
      note: a.note, status: a.status, created_at: a.created_at,
    })), { roles: ['platform_admin'], schoolScope: false });

  route('POST', '/schools/applications/:id/review', (ctx) => {
    const application = table('school_applications').find((a) => Number(a.id) === Number(ctx.params.id));
    if (!application) throw new AppError(ERR.NOT_FOUND, '申请不存在');
    if (application.status !== 'pending') throw new AppError(ERR.CONFLICT, '该申请已处理');
    const approve = ctx.body.approve !== false;
    application.status = approve ? 'approved' : 'rejected';
    application.review_note = ctx.body.note ?? null;
    application.reviewed_at = nowIso();

    let createdSchoolId = null;
    if (approve && !table('schools').some((s) => s.name === application.school_name)) {
      const school = insert('schools', {
        name: application.school_name, province: application.province, city: application.city,
        code: `S${String(Date.now()).slice(-6)}`, status: 'active',
        forum_sections: [
          { key: 'textbook', name: '教材转让' }, { key: 'seek', name: '求书专区' },
        ],
        service_fee_bps: 200, allowed_categories: configValue('content.categories', null),
        require_student_verification: 1, cross_school_enabled: 0, cross_school_mode: 'off',
        remark: '由学校开通申请审核通过自动创建', created_at: nowIso(), updated_at: nowIso(),
      });
      createdSchoolId = Number(school.id);
    }
    audit({
      actorId: ctx.user.id, actorRole: ctx.user.role, action: 'school.application.review',
      targetType: 'school_application', targetId: application.id, detail: { approve, createdSchoolId },
    });
    return { applicationId: Number(application.id), status: application.status, schoolId: createdSchoolId };
  }, { roles: ['platform_admin'], schoolScope: false });

  route('POST', '/schools/applications', (ctx) => {
    const body = ctx.body;
    requireFields(body, ['schoolName', 'province', 'city', 'applicantName', 'phone']);
    const existed = table('school_applications').find((a) => a.applicant_phone_last4 === String(body.phone).slice(-4) && a.status === 'pending');
    if (existed) throw new AppError(ERR.CONFLICT, '你已提交过申请，请耐心等待审核');
    const row = insert('school_applications', {
      school_name: body.schoolName, province: body.province, city: body.city,
      applicant_name: body.applicantName, applicant_phone_last4: String(body.phone).slice(-4),
      note: body.note ?? null, status: 'pending', reviewer_id: null, review_note: null,
      created_at: nowIso(), reviewed_at: null,
    });
    return { applicationId: Number(row.id), status: 'pending' };
  }, { public: true, schoolScope: false, message: '申请已提交，管理员审核通过后即可在注册页选择你的学校' });

  route('GET', '/schools/:id', (ctx) => {
    const school = table('schools').find((s) => Number(s.id) === Number(ctx.params.id));
    if (!school) throw new AppError(ERR.NOT_FOUND, '学校不存在');
    return {
      ...toPublicSchool(school),
      code: school.code,
      allowed_categories: school.allowed_categories || configValue('content.categories', school.id),
      uploadLimits: configValue('upload.image', school.id),
    };
  }, { public: true, schoolScope: false });

  // ---------------- 用户资料与信誉分 ----------------
  route('GET', '/users/me/profile', (ctx) => {
    const u = ctx.user;
    return {
      id: Number(u.id), school_id: u.school_id, student_no_mask: u.student_no_mask,
      phone_last4: u.phone_last4, nickname: u.nickname, avatar_url: u.avatar_url, bio: u.bio,
      real_name_mask: u.real_name_mask, role: u.role, status: u.status,
      verification_status: u.verification_status, credit_score: Number(u.credit_score),
      mute_until: u.mute_until, trade_ban_until: u.trade_ban_until, login_ban_until: u.login_ban_until,
      banned_permanently: Number(u.banned_permanently || 0), created_at: u.created_at,
      phoneMask: phoneMaskOf(u), studentNoMask: u.student_no_mask || maskStudentNo(u.student_no),
    };
  }, { schoolScope: false });

  route('PATCH', '/users/me/profile', (ctx) => {
    const u = ctx.user;
    const { nickname, avatarUrl, bio } = ctx.body;
    if (nickname !== undefined) {
      if (String(nickname).length < 1 || String(nickname).length > 30) throw new AppError(ERR.VALIDATION_ERROR, '昵称长度需在 1-30 个字符之间');
      u.nickname = String(nickname);
    }
    if (avatarUrl !== undefined) u.avatar_url = avatarUrl;
    let maskedBio = null;
    if (bio !== undefined) {
      // 个人简介同样要过违禁词检测（L1 打码，L2 起拦截）
      const decision = wordCheck({ schoolId: ctx.user.school_id, text: bio });
      if (decision.blocked) {
        throw new AppError(ERR.CONTENT_BLOCKED, `个人简介包含不允许的内容：${decision.hits.map((h) => h.word).join('、')}`, { hits: decision.hits });
      }
      maskedBio = decision.text;
      u.bio = maskedBio;
    }
    u.updated_at = nowIso();
    return { updated: true, bio: maskedBio };
  }, { schoolScope: false });

  route('GET', '/users/me/credit', (ctx) => creditPermissions(ctx.user.school_id, ctx.user.id), { schoolScope: false });

  route('GET', '/users/me/credit/logs', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    const rows = filter('credit_logs', (r) => Number(r.user_id) === Number(ctx.user.id))
      .sort((a, b) => Number(b.id) - Number(a.id));
    return { list: slicePage(rows, page, pageSize), total: rows.length };
  }, { schoolScope: false });

  route('GET', '/users/:id/public', (ctx) => {
    const user = table('users').find((u) => Number(u.id) === Number(ctx.params.id) && !u.deleted_at);
    // 跨校访问统一 404，避免泄露其他学校用户是否存在
    if (!user || Number(user.school_id) !== Number(ctx.schoolId)) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在');
    const score = Number(user.credit_score);
    const sold = filter('orders', (o) => Number(o.seller_id) === Number(user.id)
      && Number(o.school_id) === Number(ctx.schoolId)
      && ['completed', 'arbitrated_release'].includes(o.status)).length;
    const onSale = filter('books', (b) => Number(b.seller_id) === Number(user.id)
      && Number(b.school_id) === Number(ctx.schoolId) && b.status === 'on_sale' && !b.deleted_at).length;
    return {
      id: Number(user.id), nickname: user.nickname, avatarUrl: user.avatar_url, creditScore: score,
      creditTier: creditTier(ctx.schoolId, score), verified: user.verification_status === 'approved',
      soldCount: sold, onSaleCount: onSale, joinedAt: user.created_at,
    };
  });

  // ---------------- 学生认证 ----------------
  route('POST', '/verifications', (ctx) => {
    const { method, studentCardImageUrl, campusEmail } = ctx.body;
    if (!['student_card', 'campus_email'].includes(method)) throw new AppError(ERR.VALIDATION_ERROR, '认证方式不正确');
    if (method === 'student_card' && !studentCardImageUrl) throw new AppError(ERR.VALIDATION_ERROR, '请上传学生证照片');
    if (method === 'campus_email' && !campusEmail) throw new AppError(ERR.VALIDATION_ERROR, '请填写校园邮箱');
    const pending = filter('user_verifications', (v) => Number(v.user_id) === Number(ctx.user.id) && v.status === 'pending');
    if (pending.length) throw new AppError(ERR.CONFLICT, '你已有待审核的认证申请，请耐心等待');
    const row = insert('user_verifications', {
      user_id: Number(ctx.user.id), school_id: Number(ctx.schoolId), method,
      student_card_image_url: studentCardImageUrl ?? null, campus_email: campusEmail ?? null,
      status: 'pending', reviewer_id: null, review_note: null, submitted_at: nowIso(), reviewed_at: null,
    });
    ctx.user.verification_status = 'pending';
    return { verificationId: Number(row.id), status: 'pending' };
  }, { schoolScope: false, message: '认证材料已提交，审核结果将通过站内信通知' });

  route('GET', '/verifications/me', (ctx) => filter('user_verifications', (v) => Number(v.user_id) === Number(ctx.user.id))
    .sort((a, b) => Number(b.id) - Number(a.id))
    .map((v) => ({ ...v, campus_email: v.campus_email ? maskEmail(v.campus_email) : null })), { schoolScope: false });

  route('GET', '/verifications', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    const status = ctx.query.status || 'pending';
    const rows = filter('user_verifications', (v) => Number(v.school_id) === Number(ctx.schoolId) && v.status === status)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((v) => {
        const u = table('users').find((x) => Number(x.id) === Number(v.user_id)) || {};
        return {
          id: Number(v.id), user_id: Number(v.user_id), method: v.method,
          student_card_image_url: v.student_card_image_url, campus_email: v.campus_email,
          status: v.status, submitted_at: v.submitted_at,
          nickname: u.nickname, student_no_mask: u.student_no_mask, credit_score: u.credit_score,
        };
      });
    return paged(slicePage(rows, page, pageSize), rows.length, page, pageSize);
  }, { moderator: true });

  route('POST', '/verifications/:id/review', (ctx) => {
    const verification = table('user_verifications').find((v) => Number(v.id) === Number(ctx.params.id));
    if (!verification || Number(verification.school_id) !== Number(ctx.schoolId)) throw new AppError(ERR.NOT_FOUND, '认证记录不存在');
    if (verification.status !== 'pending') throw new AppError(ERR.ORDER_STATE_INVALID, '该认证已审核');
    const approve = ctx.body.approve !== false;
    verification.status = approve ? 'approved' : 'rejected';
    verification.reviewer_id = Number(ctx.user.id);
    verification.review_note = ctx.body.note ?? null;
    verification.reviewed_at = nowIso();
    const target = table('users').find((u) => Number(u.id) === Number(verification.user_id));
    if (target) target.verification_status = verification.status;
    notify(verification.user_id, {
      schoolId: Number(ctx.schoolId), type: 'verification',
      title: approve ? '学生认证已通过' : '学生认证未通过',
      content: approve ? '认证通过，现在可以发布教材并交易了' : `认证未通过：${ctx.body.note || '材料不清晰，请重新提交'}`,
      relatedType: 'user_verification', relatedId: verification.id,
    });
    audit({
      schoolId: Number(ctx.schoolId), actorId: ctx.user.id, actorRole: ctx.user.role,
      action: 'verification.review', targetType: 'user_verification', targetId: verification.id,
      detail: { approve, note: ctx.body.note },
    });
    return { verificationId: Number(verification.id), status: verification.status };
  }, { moderator: true, message: '审核完成' });

  // ---------------- 收款绑定（只保存脱敏信息） ----------------
  route('GET', '/payment-accounts', (ctx) => filter('payment_accounts', (a) => Number(a.user_id) === Number(ctx.user.id)
    && a.status !== 'unbound').map((a) => ({
    id: Number(a.id), type: a.type, account_name_mask: a.account_name_mask,
    account_no_last4: a.account_no_last4, bank_name: a.bank_name, status: a.status,
    is_default: Number(a.is_default), bound_at: a.bound_at, cooldown_until: a.cooldown_until,
  })), { schoolScope: false });

  route('POST', '/payment-accounts', (ctx) => {
    const { type, accountNo, accountName, bankName, smsCode, isDefault } = ctx.body;
    requireFields(ctx.body, ['type', 'accountNo', 'accountName', 'smsCode']);
    if (!['wechat', 'alipay', 'bank'].includes(type)) throw new AppError(ERR.VALIDATION_ERROR, '收款方式不支持');
    // 换绑冷却：24 小时内不可重新绑定
    const cooling = filter('payment_accounts', (a) => Number(a.user_id) === Number(ctx.user.id)
      && a.cooldown_until && new Date(a.cooldown_until) > new Date());
    if (cooling.length) {
      throw new AppError(ERR.COOLDOWN_ACTIVE, `换绑冷却中，可绑定时间：${new Date(cooling[0].cooldown_until).toLocaleString('zh-CN')}`, {
        until: cooling[0].cooldown_until,
      });
    }
    if (type === 'bank' && !bankName) throw new AppError(ERR.VALIDATION_ERROR, '请填写开户银行');
    const nameMask = maskName(accountName);
    const realNameMask = ctx.user.real_name_mask;
    if (realNameMask && nameMask[0] !== realNameMask[0]) {
      throw new AppError(ERR.VALIDATION_ERROR, '收款账号实名信息与账号实名不一致，请核对后重试');
    }
    if (isDefault) {
      for (const a of filter('payment_accounts', (x) => Number(x.user_id) === Number(ctx.user.id))) a.is_default = 0;
    }
    const row = insert('payment_accounts', {
      user_id: Number(ctx.user.id), school_id: ctx.user.school_id, type,
      account_name_mask: nameMask,
      account_no_last4: String(accountNo).replace(/\s/g, '').slice(-4),
      bank_name: type === 'bank' ? bankName : null, status: 'active',
      is_default: isDefault ? 1 : 0, bound_at: nowIso(), unbind_at: null, cooldown_until: null,
    });
    audit({
      schoolId: ctx.user.school_id, actorId: ctx.user.id, actorRole: ctx.user.role,
      action: 'payment_account.bind', targetType: 'payment_account', targetId: row.id,
      detail: { type, last4: row.account_no_last4 },
    });
    return {
      id: Number(row.id), type: row.type, account_name_mask: row.account_name_mask,
      account_no_last4: row.account_no_last4, bank_name: row.bank_name, is_default: Number(row.is_default),
    };
  }, { schoolScope: false, message: '绑定成功，仅保存脱敏信息' });

  route('POST', '/payment-accounts/:id/unbind/code', (ctx) => {
    const account = table('payment_accounts').find((a) => Number(a.id) === Number(ctx.params.id) && Number(a.user_id) === Number(ctx.user.id));
    if (!account) throw new AppError(ERR.NOT_FOUND, '收款方式不存在');
    return { sent: true, devCode: '123456' };
  }, { schoolScope: false, message: '验证码已发送' });

  route('POST', '/payment-accounts/:id/unbind', (ctx) => {
    const account = table('payment_accounts').find((a) => Number(a.id) === Number(ctx.params.id) && Number(a.user_id) === Number(ctx.user.id));
    if (!account) throw new AppError(ERR.NOT_FOUND, '收款方式不存在');
    if (!/^\d{6}$/.test(String(ctx.body.smsCode || ''))) throw new AppError(ERR.SMS_CODE_INVALID, '短信验证码不正确');
    account.status = 'unbound';
    account.unbind_at = nowIso();
    account.cooldown_until = isoAfter(24 * 3600000);
    account.is_default = 0;
    return { id: Number(account.id), status: 'unbound', cooldownUntil: account.cooldown_until };
  }, { schoolScope: false, message: '已解绑，24 小时内不可重新绑定' });

  route('POST', '/payment-accounts/:id/default', (ctx) => {
    const account = table('payment_accounts').find((a) => Number(a.id) === Number(ctx.params.id) && Number(a.user_id) === Number(ctx.user.id));
    if (!account) throw new AppError(ERR.NOT_FOUND, '收款方式不存在');
    for (const a of filter('payment_accounts', (x) => Number(x.user_id) === Number(ctx.user.id))) a.is_default = 0;
    account.is_default = 1;
    return { id: Number(account.id), isDefault: true };
  }, { schoolScope: false });

  // ---------------- 通知 ----------------
  route('GET', '/notifications/unread-count', (ctx) => ({
    unread: filter('notifications', (n) => Number(n.user_id) === Number(ctx.user.id) && !Number(n.is_read)).length,
  }), { schoolScope: false });

  route('POST', '/notifications/read-all', (ctx) => {
    for (const n of filter('notifications', (x) => Number(x.user_id) === Number(ctx.user.id))) {
      n.is_read = 1;
      n.read_at = nowIso();
    }
    return { readAll: true };
  }, { schoolScope: false, message: '已全部标记为已读' });

  route('GET', '/notifications', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    const isRead = ctx.query.isRead === undefined ? null : String(ctx.query.isRead) === 'true';
    const rows = filter('notifications', (n) => Number(n.user_id) === Number(ctx.user.id)
      && (isRead === null || Boolean(Number(n.is_read)) === isRead)
      && (!ctx.query.type || n.type === ctx.query.type))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map((n) => ({
        id: Number(n.id), type: n.type, title: n.title, content: n.content,
        related_type: n.related_type, related_id: n.related_id, is_read: Number(n.is_read), sent_at: n.sent_at,
      }));
    return paged(slicePage(rows, page, pageSize), rows.length, page, pageSize);
  }, { schoolScope: false });

  route('POST', '/notifications/:id/read', (ctx) => {
    const n = table('notifications').find((x) => Number(x.id) === Number(ctx.params.id) && Number(x.user_id) === Number(ctx.user.id));
    if (n) {
      n.is_read = 1;
      n.read_at = nowIso();
    }
    return { read: true };
  }, { schoolScope: false });
}


