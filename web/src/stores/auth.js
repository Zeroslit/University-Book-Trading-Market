// 登录态仓库：持有用户、学校、钱包与权限判定；登录后按 school_id 直接进入本校内容
import { defineStore } from 'pinia';
import { authApi, walletApi } from '../api/index.js';
import { setTokens, clearTokens, hasToken } from '../api/client.js';
import { t } from '../i18n/index.js';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    school: null,
    wallet: null,
    loading: false,
    loaded: false,
  }),
  getters: {
    isLoggedIn: (s) => Boolean(s.user),
    role: (s) => s.user?.role || 'guest',
    isStudent: (s) => s.role === 'student',
    isModerator: (s) => ['school_admin', 'support', 'platform_admin'].includes(s.role),
    isStaff: (s) => ['school_admin', 'support', 'platform_admin'].includes(s.role),
    isPlatformAdmin: (s) => s.role === 'platform_admin',
    // 客服 / 平台管理员跨校：需要显式选择学校
    needSchoolPicker: (s) => ['support', 'platform_admin'].includes(s.role),
    verified: (s) => s.user?.verificationStatus === 'approved',
    schoolName: (s) => s.school?.name || t('平台'),
  },
  actions: {
    async load(force = false) {
      if (!hasToken()) { this.reset(); return null; }
      if (this.loaded && !force) return this.user;
      this.loading = true;
      try {
        const data = await authApi.me();
        this.user = data.user;
        this.school = data.school;
        this.wallet = data.wallet;
        this.loaded = true;
        return this.user;
      } catch (err) {
        if (err?.code === 40101 || err?.code === 40102 || err?.code === 40103) {
          this.reset();
        }
        throw err;
      } finally {
        this.loading = false;
      }
    },
    async login({ phone, password }) {
      const data = await authApi.login({ phone, password });
      setTokens(data);
      this.user = data.user;
      await this.load(true);
      return data;
    },
    async register(payload) {
      const data = await authApi.register(payload);
      setTokens(data);
      this.user = data.user;
      await this.load(true);
      return data;
    },
    async refreshWallet() {
      if (!hasToken()) return null;
      this.wallet = await walletApi.account();
      return this.wallet;
    },
    async logout() {
      try { await authApi.logout(); } catch { /* 退出失败也要清本地状态 */ }
      this.reset();
    },
    reset() {
      clearTokens();
      this.user = null;
      this.school = null;
      this.wallet = null;
      this.loaded = false;
    },
  },
});
