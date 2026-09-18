// 脱敏工具：所有对外输出都必须经过这里，禁止直接把敏感字段返回给前端
export function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 7) return '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

export function maskStudentNo(no) {
  const s = String(no || '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(1, s.length - 4))}${s.slice(-2)}`;
}

export function maskBankCard(card) {
  const s = String(card || '');
  if (s.length < 4) return '****';
  return `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
}

export function maskName(name) {
  const s = String(name || '');
  if (!s) return '';
  if (s.length === 1) return s;
  return `${s[0]}${'*'.repeat(s.length - 1)}`;
}

export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '****';
  const name = s.slice(0, at);
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(1, name.length - visible.length))}${s.slice(at)}`;
}

// 内容打码（L1 提示类命中时使用）：保留首尾，中间打码
export function maskMatch(text, keep = 1) {
  const s = String(text || '');
  if (s.length <= keep * 2) return '*'.repeat(s.length);
  return `${s.slice(0, keep)}${'*'.repeat(s.length - keep * 2)}${s.slice(-keep)}`;
}

// 对整段文本中的命中的敏感片段打码
export function maskSegments(text, segments) {
  if (!segments || segments.length === 0) return text;
  const chars = Array.from(String(text));
  const sorted = [...segments].sort((a, b) => b.start - a.start);
  for (const seg of sorted) {
    const raw = chars.slice(seg.start, seg.end + 1).join('');
    chars.splice(seg.start, seg.end - seg.start + 1, maskMatch(raw));
  }
  return chars.join('');
}
