// 通用格式化与状态字典：页面统一从这里取文案，避免各页面各写一套

export function centsToYuan(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

export function yuanToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

export function formatTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDate(value) {
  return formatTime(value).slice(0, 10);
}

// 距今剩余时间文案（用于自动确认收货倒计时、封禁到期时间等）
export function countdownText(until) {
  if (!until) return '';
  const diff = new Date(until).getTime() - Date.now();
  if (Number.isNaN(diff) || diff <= 0) return '已到期';
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `剩余 ${days} 天 ${hours % 24} 小时`;
  const minutes = Math.floor((diff % 3600000) / 60000);
  return `剩余 ${hours} 小时 ${minutes} 分`;
}

export const ORDER_STATUS = {
  pending_payment: { label: '待付款', tag: 'tag-warning' },
  paid: { label: '已付款（资金托管中）', tag: 'tag-info' },
  shipped: { label: '卖家已发货', tag: 'tag-info' },
  completed: { label: '已完成', tag: 'tag-success' },
  cancelled: { label: '已取消', tag: '' },
  refund_requested: { label: '退款申请中', tag: 'tag-warning' },
  refunded: { label: '已退款', tag: 'tag-danger' },
  return_requested: { label: '退货退款中', tag: 'tag-warning' },
  disputed: { label: '争议中（放款已冻结）', tag: 'tag-danger' },
  arbitrated_refund: { label: '仲裁退款', tag: 'tag-danger' },
  arbitrated_release: { label: '仲裁放款', tag: 'tag-success' },
};

export const ESCROW_STATUS = {
  none: { label: '未托管', tag: '' },
  held: { label: '托管中', tag: 'tag-info' },
  released: { label: '已放款卖家', tag: 'tag-success' },
  refunded: { label: '已退回买家', tag: 'tag-danger' },
  frozen: { label: '争议冻结', tag: 'tag-danger' },
};

export const BOOK_STATUS = {
  on_sale: { label: '在售', tag: 'tag-success' },
  off_shelf: { label: '已下架', tag: '' },
  locked: { label: '订单锁定中', tag: 'tag-warning' },
  sold: { label: '已售出', tag: 'tag-info' },
};

export const CONDITION_LABELS = {
  new: '全新',
  like_new: '九成新',
  good: '七成新',
  fair: '五成新',
  poor: '有笔记/破损',
};

export const THREAD_TYPE = {
  seek: { label: '求书帖', tag: 'tag-info' },
  sell: { label: '转让帖', tag: 'tag-success' },
};

export const SHIP_MODE = {
  meetup: '校内面交',
  mail: '邮寄',
};

export const VERIFICATION_STATUS = {
  unverified: { label: '未认证', tag: 'tag-warning' },
  pending: { label: '审核中', tag: 'tag-info' },
  approved: { label: '已认证', tag: 'tag-success' },
  rejected: { label: '认证未通过', tag: 'tag-danger' },
};

export const REPORT_STATUS = {
  pending: { label: '待受理', tag: 'tag-warning' },
  accepted: { label: '已受理（举证中）', tag: 'tag-info' },
  decided: { label: '已裁定', tag: 'tag-success' },
  rejected: { label: '不予受理', tag: '' },
  withdrawn: { label: '已撤回', tag: '' },
};

export const APPEAL_STATUS = {
  pending: { label: '申诉受理中', tag: 'tag-warning' },
  approved: { label: '申诉成功（处罚已撤销）', tag: 'tag-success' },
  rejected: { label: '申诉驳回', tag: 'tag-danger' },
};

export const TICKET_STATUS = {
  pending: { label: '待受理', tag: 'tag-warning' },
  processing: { label: '处理中', tag: 'tag-info' },
  resolved: { label: '已完成', tag: 'tag-success' },
  escalated: { label: '已升级', tag: 'tag-danger' },
  closed: { label: '已关闭', tag: '' },
};

export const TICKET_PRIORITY = {
  low: { label: '低', tag: '' },
  normal: { label: '普通', tag: '' },
  high: { label: '高', tag: 'tag-warning' },
  urgent: { label: '紧急', tag: 'tag-danger' },
};

export const TICKET_TYPE = {
  order: '订单问题',
  refund: '退款/资金',
  account: '账号问题',
  content: '内容违规',
  other: '其他',
};

export const NOTIFICATION_TYPE = {
  order: '订单',
  system: '系统',
  report: '投诉',
  penalty: '处罚',
  verification: '认证',
  ticket: '工单',
  withdraw: '资金',
  word: '内容提醒',
};

export const WORD_LEVEL = {
  L1: { label: 'L1 提示', tag: 'tag-warning' },
  L2: { label: 'L2 拦截', tag: 'tag-danger' },
  L3: { label: 'L3 违规', tag: 'tag-danger' },
  L4: { label: 'L4 严重', tag: 'tag-danger' },
};

export function dict(map, key) {
  return map[key] || { label: key || '-', tag: '' };
}
