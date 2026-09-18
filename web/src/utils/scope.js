// 学校上下文：学生/校管用登录态学校；客服/平台管理员需在导航栏显式选择学校
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth.js';
import { useSchoolStore } from '../stores/school.js';

export function useScope() {
  const auth = useAuthStore();
  const school = useSchoolStore();
  const schoolId = computed(() => {
    if (auth.needSchoolPicker) return school.currentId || null;
    return auth.user?.schoolId || null;
  });
  const ready = computed(() => Boolean(schoolId.value));
  return { auth, school, schoolId, ready };
}
