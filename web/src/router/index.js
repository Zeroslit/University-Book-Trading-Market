// 路由与全局守卫：未登录跳登录页，未认证跳认证页，后台按角色限制
import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { hasToken } from '../api/client.js';

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/Login.vue'), meta: { public: true, title: '登录' } },
  { path: '/register', name: 'register', component: () => import('../views/Register.vue'), meta: { public: true, title: '注册' } },

  { path: '/', name: 'home', component: () => import('../views/Home.vue'), meta: { title: '本校首页' } },
  { path: '/books', name: 'books', component: () => import('../views/Books.vue'), meta: { title: '教材图书库' } },
  { path: '/books/new', name: 'book-publish', component: () => import('../views/BookPublish.vue'), meta: { title: '发布教材', requireVerified: true } },
  { path: '/books/:id', name: 'book-detail', component: () => import('../views/BookDetail.vue'), meta: { title: '教材详情' } },
  { path: '/threads', name: 'threads', component: () => import('../views/Threads.vue'), meta: { title: '校园论坛' } },
  { path: '/threads/new', name: 'thread-publish', component: () => import('../views/ThreadPublish.vue'), meta: { title: '发帖', requireVerified: true } },
  { path: '/threads/:id', name: 'thread-detail', component: () => import('../views/ThreadDetail.vue'), meta: { title: '帖子详情' } },
  { path: '/messages', name: 'messages', component: () => import('../views/Messages.vue'), meta: { title: '私信' } },
  { path: '/orders', name: 'orders', component: () => import('../views/Orders.vue'), meta: { title: '我的订单' } },
  { path: '/orders/:id', name: 'order-detail', component: () => import('../views/OrderDetail.vue'), meta: { title: '订单详情' } },
  { path: '/wallet', name: 'wallet', component: () => import('../views/Wallet.vue'), meta: { title: '我的钱包' } },
  { path: '/notifications', name: 'notifications', component: () => import('../views/Notifications.vue'), meta: { title: '消息通知' } },
  { path: '/credit', name: 'credit', component: () => import('../views/Credit.vue'), meta: { title: '信誉分' } },
  { path: '/verification', name: 'verification', component: () => import('../views/Verification.vue'), meta: { title: '学生认证' } },
  { path: '/payment-accounts', name: 'payment-accounts', component: () => import('../views/PaymentAccounts.vue'), meta: { title: '收款绑定' } },
  { path: '/profile', name: 'profile', component: () => import('../views/Profile.vue'), meta: { title: '个人中心' } },
  { path: '/reports', name: 'reports', component: () => import('../views/Reports.vue'), meta: { title: '举报与投诉' } },
  { path: '/appeals', name: 'appeals', component: () => import('../views/Appeals.vue'), meta: { title: '处罚申诉' } },
  { path: '/support', name: 'support', component: () => import('../views/Support.vue'), meta: { title: '客服中心' } },

  // 管理后台：学校管理员 / 客服 / 平台管理员
  { path: '/admin', redirect: '/admin/dashboard' },
  { path: '/admin/dashboard', name: 'admin-dashboard', component: () => import('../views/admin/Dashboard.vue'), meta: { title: '数据看板', admin: true } },
  { path: '/admin/contents', name: 'admin-contents', component: () => import('../views/admin/Contents.vue'), meta: { title: '内容审核', admin: true } },
  { path: '/admin/users', name: 'admin-users', component: () => import('../views/admin/Users.vue'), meta: { title: '用户与风控', admin: true } },
  { path: '/admin/words', name: 'admin-words', component: () => import('../views/admin/Words.vue'), meta: { title: '违禁词库', admin: true } },
  { path: '/admin/tickets', name: 'admin-tickets', component: () => import('../views/admin/Tickets.vue'), meta: { title: '工单队列', admin: true } },
  { path: '/admin/arbitration', name: 'admin-arbitration', component: () => import('../views/admin/Arbitration.vue'), meta: { title: '订单仲裁', admin: true } },
  { path: '/admin/reports', name: 'admin-reports', component: () => import('../views/admin/ReportQueue.vue'), meta: { title: '投诉裁定', admin: true } },
  { path: '/admin/schools', name: 'admin-schools', component: () => import('../views/admin/Schools.vue'), meta: { title: '学校管理', platform: true } },
  { path: '/admin/configs', name: 'admin-configs', component: () => import('../views/admin/Configs.vue'), meta: { title: '规则阈值', platform: true } },
  { path: '/admin/audit-logs', name: 'admin-audit-logs', component: () => import('../views/admin/AuditLogs.vue'), meta: { title: '审计日志', platform: true } },
  { path: '/admin/kb', name: 'admin-kb', component: () => import('../views/admin/Kb.vue'), meta: { title: '客服知识库', admin: true } },

  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('../views/NotFound.vue'), meta: { public: true, title: '页面不存在' } },
];

// 基路径跟随 Vite 的 base：本地开发为 /，GitHub Pages 演示为 /<repo>/web/
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  document.title = to.meta?.title ? `${to.meta.title} · 校园教材循环` : '校园教材循环';

  if (to.meta?.public) return true;
  if (!hasToken()) return { name: 'login', query: { redirect: to.fullPath } };

  if (!auth.loaded) {
    try {
      await auth.load();
    } catch {
      return { name: 'login', query: { redirect: to.fullPath } };
    }
  }

  if (to.meta?.admin && !auth.isModerator) return { name: 'home' };
  if (to.meta?.platform && !auth.isPlatformAdmin) return { name: 'admin-dashboard' };
  if (to.meta?.requireVerified && !auth.verified) {
    return { name: 'verification', query: { from: to.fullPath } };
  }
  return true;
});

export default router;
