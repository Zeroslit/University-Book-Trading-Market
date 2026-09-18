// 学校上下文：学生由登录态决定；客服/平台管理员需显式选择要操作的学校（跨校必传 schoolId）
import { defineStore } from 'pinia';
import { schoolApi } from '../api/index.js';

const STORAGE_KEY = 'campus_book_school_ctx';

export const useSchoolStore = defineStore('school', {
  state: () => ({
    options: [],
    loading: false,
    currentId: Number(localStorage.getItem(STORAGE_KEY)) || null,
  }),
  getters: {
    current: (s) => s.options.find((x) => Number(x.id) === Number(s.currentId)) || null,
  },
  actions: {
    async search({ keyword = '', province = '', city = '' } = {}) {
      this.loading = true;
      try {
        const data = await schoolApi.list({ keyword, province, city, pageSize: 50 });
        this.options = data.list || [];
        return this.options;
      } finally {
        this.loading = false;
      }
    },
    setCurrent(id) {
      this.currentId = id ? Number(id) : null;
      if (this.currentId) localStorage.setItem(STORAGE_KEY, String(this.currentId));
      else localStorage.removeItem(STORAGE_KEY);
    },
  },
});
