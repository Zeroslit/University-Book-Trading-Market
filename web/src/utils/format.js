import { t } from '../i18n/index.js';
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
  if (Number.isNaN(diff) || diff <= 0) return t('已到期');
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${t('剩余 {0} 天 {1} 小时', [days, hours % 24])}`;
  const minutes = Math.floor((diff % 3600000) / 60000);
  return `${t('剩余 {0} 小时 {1} 分', [hours, minutes])}`;
}

// 信誉分档位：后端配置里带 label，但那是「数据」；这里按档位 key 给出可翻译的展示名，
// 保证英文界面下不会冒出中文档位名（配置被学校改过时回落到后端返回的 label）。
export const CREDIT_TIER = {
  get excellent() { return t('优秀'); },
  get good() { return t('良好'); },
  get limited() { return t('受限'); },
  get high_risk() { return t('高风险'); },
  get banned() { return t('禁止交易'); },
};

export const ORDER_STATUS = {
  pending_payment: { get label() { return t('待付款') }, tag: 'tag-warning' },
  paid: { get label() { return t('已付款（资金托管中）') }, tag: 'tag-info' },
  shipped: { get label() { return t('卖家已发货') }, tag: 'tag-info' },
  completed: { get label() { return t('已完成') }, tag: 'tag-success' },
  cancelled: { get label() { return t('已取消') }, tag: '' },
  refund_requested: { get label() { return t('退款申请中') }, tag: 'tag-warning' },
  refunded: { get label() { return t('已退款') }, tag: 'tag-danger' },
  return_requested: { get label() { return t('退货退款中') }, tag: 'tag-warning' },
  disputed: { get label() { return t('争议中（放款已冻结）') }, tag: 'tag-danger' },
  arbitrated_refund: { get label() { return t('仲裁退款') }, tag: 'tag-danger' },
  arbitrated_release: { get label() { return t('仲裁放款') }, tag: 'tag-success' },
};

export const ESCROW_STATUS = {
  none: { get label() { return t('未托管') }, tag: '' },
  held: { get label() { return t('托管中') }, tag: 'tag-info' },
  released: { get label() { return t('已放款卖家') }, tag: 'tag-success' },
  refunded: { get label() { return t('已退回买家') }, tag: 'tag-danger' },
  frozen: { get label() { return t('争议冻结') }, tag: 'tag-danger' },
};

export const BOOK_STATUS = {
  on_sale: { get label() { return t('在售') }, tag: 'tag-success' },
  off_shelf: { get label() { return t('已下架') }, tag: '' },
  locked: { get label() { return t('订单锁定中') }, tag: 'tag-warning' },
  sold: { get label() { return t('已售出') }, tag: 'tag-info' },
};

export const CONDITION_LABELS = {
  get new() { return t('全新') },
  get like_new() { return t('九成新') },
  get good() { return t('七成新') },
  get fair() { return t('五成新') },
  get poor() { return t('有笔记/破损') },
};

export const THREAD_TYPE = {
  seek: { get label() { return t('求书帖') }, tag: 'tag-info' },
  sell: { get label() { return t('转让帖') }, tag: 'tag-success' },
};

export const SHIP_MODE = {
  get meetup() { return t('校内面交') },
  get mail() { return t('邮寄') },
};

export const VERIFICATION_STATUS = {
  unverified: { get label() { return t('未认证') }, tag: 'tag-warning' },
  pending: { get label() { return t('审核中') }, tag: 'tag-info' },
  approved: { get label() { return t('已认证') }, tag: 'tag-success' },
  rejected: { get label() { return t('认证未通过') }, tag: 'tag-danger' },
};

export const REPORT_STATUS = {
  pending: { get label() { return t('待受理') }, tag: 'tag-warning' },
  accepted: { get label() { return t('已受理（举证中）') }, tag: 'tag-info' },
  decided: { get label() { return t('已裁定') }, tag: 'tag-success' },
  rejected: { get label() { return t('不予受理') }, tag: '' },
  withdrawn: { get label() { return t('已撤回') }, tag: '' },
};

export const APPEAL_STATUS = {
  pending: { get label() { return t('申诉受理中') }, tag: 'tag-warning' },
  approved: { get label() { return t('申诉成功（处罚已撤销）') }, tag: 'tag-success' },
  rejected: { get label() { return t('申诉驳回') }, tag: 'tag-danger' },
};

export const TICKET_STATUS = {
  pending: { get label() { return t('待受理') }, tag: 'tag-warning' },
  processing: { get label() { return t('处理中') }, tag: 'tag-info' },
  resolved: { get label() { return t('已完成') }, tag: 'tag-success' },
  escalated: { get label() { return t('已升级') }, tag: 'tag-danger' },
  closed: { get label() { return t('已关闭') }, tag: '' },
};

export const TICKET_PRIORITY = {
  low: { get label() { return t('低') }, tag: '' },
  normal: { get label() { return t('普通') }, tag: '' },
  high: { get label() { return t('高') }, tag: 'tag-warning' },
  urgent: { get label() { return t('紧急') }, tag: 'tag-danger' },
};

export const TICKET_TYPE = {
  get order() { return t('订单问题') },
  get refund() { return t('退款/资金') },
  get account() { return t('账号问题') },
  get content() { return t('内容违规') },
  get other() { return t('其他') },
};

export const NOTIFICATION_TYPE = {
  get order() { return t('订单') },
  get system() { return t('系统') },
  get report() { return t('投诉') },
  get penalty() { return t('处罚') },
  get verification() { return t('认证') },
  get ticket() { return t('工单') },
  get withdraw() { return t('资金') },
  get word() { return t('内容提醒') },
};

export const WORD_LEVEL = {
  L1: { get label() { return t('L1 提示') }, tag: 'tag-warning' },
  L2: { get label() { return t('L2 拦截') }, tag: 'tag-danger' },
  L3: { get label() { return t('L3 违规') }, tag: 'tag-danger' },
  L4: { get label() { return t('L4 严重') }, tag: 'tag-danger' },
};

export function dict(map, key) {
  return map[key] || { label: key || '-', tag: '' };
}
