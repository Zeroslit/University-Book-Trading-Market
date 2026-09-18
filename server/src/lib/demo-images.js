// 演示图片生成：为种子数据写出真实的封面/学生证占位图（SVG，矢量、体积小、无需外部依赖）
// 说明：一期不接入真实图片素材，这里按书名生成确定性的示例封面，便于本地与演示环境直接看到成图
import fs from 'node:fs';
import path from 'node:path';

const PALETTE = [
  ['#4f7cff', '#7aa2ff'], ['#12b886', '#63e6be'], ['#f76707', '#ffc078'],
  ['#7048e8', '#b197fc'], ['#0c8599', '#66d9e8'], ['#e8590c', '#ffa94d'],
  ['#c2255c', '#f783ac'], ['#2b8a3e', '#8ce99a'], ['#1864ab', '#4dabf7'],
  ['#5f3dc4', '#9775fa'],
];

function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// 中文按字符宽度折行（中文按 1 个字宽，英文数字按 0.55）
function wrapText(text, perLine) {
  const chars = [...String(text ?? '')];
  const lines = [];
  let current = '';
  let width = 0;
  for (const ch of chars) {
    const w = /[\x00-\xff]/.test(ch) ? 0.55 : 1;
    if (width + w > perLine && current) {
      lines.push(current);
      current = ch;
      width = w;
    } else {
      current += ch;
      width += w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function textWidth(text) {
  return [...String(text ?? '')].reduce((sum, ch) => sum + (/[\x00-\xff]/.test(ch) ? 0.55 : 1), 0);
}

// 依据书名长度选择行数与字号，保证不溢出封面卡片（卡片内可用宽度约 800px）
function layoutTitle(title) {
  const width = textWidth(title);
  let perLine; let maxLines; let fontSize;
  if (width <= 9) { perLine = 9; maxLines = 1; fontSize = 86; }
  else if (width <= 18) { perLine = 9; maxLines = 2; fontSize = 84; }
  else if (width <= 30) { perLine = 11; maxLines = 3; fontSize = 68; }
  else { perLine = 13; maxLines = 4; fontSize = 56; }
  let lines = wrapText(title, perLine);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
  }
  return { lines, fontSize };
}

// 图书封面：渐变底 + 卡片 + 书名/作者/课程/成色
function bookCover({ title, author, course, publisher, condition, index, variant }) {
  const [from, to] = PALETTE[index % PALETTE.length];
  const { lines: titleLines, fontSize } = layoutTitle(title);
  const startY = 330 - (titleLines.length - 1) * (fontSize * 0.62);
  const titleTspans = titleLines.map((line, i) => (
    `<tspan x="540" y="${Math.round(startY + i * fontSize * 1.24)}">${escapeXml(line)}</tspan>`
  )).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="810" viewBox="0 0 1080 810" role="img" aria-label="${escapeXml(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient>
    <linearGradient id="spine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.16"/><stop offset="1" stop-color="#000" stop-opacity="0.04"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="810" fill="url(#bg)"/>
  <circle cx="960" cy="120" r="210" fill="#ffffff" opacity="0.10"/>
  <circle cx="120" cy="720" r="260" fill="#000000" opacity="0.06"/>
  <g transform="translate(90,75)">
    <rect width="900" height="660" rx="30" fill="#ffffff" opacity="0.95"/>
    <rect width="26" height="660" rx="13" fill="url(#spine)"/>
  </g>
  <text x="120" y="150" font-family="PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif" font-size="30" fill="#868e96">教材实拍图（示例 · ${variant}）</text>
  <text text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#212529">${titleTspans}</text>
  <text x="540" y="470" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif" font-size="40" fill="#495057">${escapeXml(author)}</text>
  <text x="540" y="530" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif" font-size="32" fill="#868e96">${escapeXml(publisher)}</text>
  <g transform="translate(150,600)">
    <rect width="330" height="70" rx="35" fill="${from}" opacity="0.14"/>
    <text x="165" y="46" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif" font-size="32" fill="${from}">课程：${escapeXml(course)}</text>
  </g>
  <g transform="translate(600,600)">
    <rect width="330" height="70" rx="35" fill="#000000" opacity="0.06"/>
    <text x="165" y="46" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif" font-size="32" fill="#495057">成色：${escapeXml(condition)}</text>
  </g>
</svg>
`;
}

// 学生证占位图（认证材料）
function verificationCard(index) {
  const [from, to] = PALETTE[index % PALETTE.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="810" viewBox="0 0 1080 810" role="img" aria-label="学生证示例">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect width="1080" height="810" fill="#f1f3f5"/>
  <rect x="60" y="60" width="960" height="690" rx="28" fill="url(#bg)"/>
  <rect x="110" y="150" width="860" height="510" rx="20" fill="#ffffff" opacity="0.94"/>
  <rect x="150" y="200" width="220" height="280" rx="12" fill="#dee2e6"/>
  <text x="260" y="355" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="34" fill="#868e96">证件照</text>
  <text x="420" y="270" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="40" font-weight="700" fill="#212529">学生证（示例材料）</text>
  <text x="420" y="340" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="30" fill="#495057">姓名：演示同学</text>
  <text x="420" y="400" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="30" fill="#495057">学号：20******0${index % 10}</text>
  <text x="420" y="460" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="30" fill="#495057">院系：示例学院</text>
  <text x="160" y="620" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="28" fill="#868e96">仅用于演示，非真实证件</text>
</svg>
`;
}

// 帖子配图
function threadImage(title) {
  const lines = wrapText(title, 14).slice(0, 2);
  const tspans = lines.map((line, i) => `<tspan x="540" y="${360 + i * 70}">${escapeXml(line)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="810" viewBox="0 0 1080 810" role="img" aria-label="帖子配图示例">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#495057"/><stop offset="1" stop-color="#adb5bd"/></linearGradient></defs>
  <rect width="1080" height="810" fill="url(#bg)"/>
  <text text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="56" font-weight="700" fill="#ffffff">${tspans}</text>
  <text x="540" y="520" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="30" fill="#ffffff" opacity="0.8">校园实拍图（示例）</text>
</svg>
`;
}

/**
 * 写出演示图片到 uploads/demo 目录
 * @param {object} options
 * @param {string} options.dir 图片输出目录（uploads/demo）
 * @param {Array} options.books 书籍信息数组
 * @param {string} [options.threadTitle] 帖子配图对应标题
 * @param {number} [options.verificationCount] 学生证图片数量
 */
export function writeDemoImages({ dir, books, threadTitle = '校园论坛帖子配图', verificationCount = 9 }) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const write = (name, content) => {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
    written.push(name);
  };
  books.forEach((book, i) => {
    for (let k = 1; k <= 2; k += 1) {
      write(`book-${i + 1}-${k}.svg`, bookCover({ ...book, index: i, variant: `图 ${k}` }));
    }
  });
  write('thread-2-1.svg', threadImage(threadTitle));
  for (let i = 1; i <= verificationCount; i += 1) {
    write(`verification-${i}.svg`, verificationCard(i));
  }
  return written;
}

export const DEMO_IMAGE_DIR = 'demo';
