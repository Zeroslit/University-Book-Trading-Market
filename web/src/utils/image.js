// 图片压缩：上传前把长边压到 <=1080px，输出 jpeg（后端只接收 jpg/png/webp）
const MAX_EDGE = 1080;
const DEFAULT_QUALITY = 0.82;

function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
}

export async function compressImage(file, { maxEdge = MAX_EDGE, quality = DEFAULT_QUALITY } = {}) {
  if (!file) throw new Error('请选择图片');
  if (!String(file.type).startsWith('image/')) throw new Error('只支持图片文件');
  // GIF 可能是动图，压缩会丢帧，直接原图上传
  if (file.type === 'image/gif') return file;

  const bitmap = await loadImage(file);
  const srcWidth = bitmap.width || bitmap.naturalWidth;
  const srcHeight = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(srcWidth, srcHeight));
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return file;
  const name = `${String(file.name).replace(/\.[^.]+$/, '') || 'image'}.jpg`;
  return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
}

// 图片地址补全：后端返回的是 /static/... 相对地址
// 演示模式（子路径部署）下需要补上构建基路径，例如 /University-Book-Trading-Market/web/static/...
const BASE_URL = import.meta.env.BASE_URL || '/';

export function imageUrl(url) {
  if (!url) return '';
  if (/^(https?:)?\/\//.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (String(import.meta.env.VITE_DEMO) === 'true') return BASE_URL + (url.startsWith('/') ? url.slice(1) : url);
  return url.startsWith('/') ? url : `/${url}`;
}
