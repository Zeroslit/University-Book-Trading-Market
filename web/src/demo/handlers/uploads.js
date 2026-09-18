// 演示版图片上传：前端已把长边压到 <=1080px，这里只做类型/体积校验并转成内联 data URL
// 说明：演示环境没有对象存储，图片只存在浏览器内存中，刷新/重置后即消失（真实部署走对象存储并只存 URL）
import { AppError, ERR } from '../vendor.js';
import { configOr } from './risk.js';

const ALLOW_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new AppError(ERR.INTERNAL, '图片读取失败，请重试'));
    reader.readAsDataURL(file);
  });
}

export function registerUploadRoutes(route) {
  route('POST', '/uploads/image', async (ctx) => {
    const file = ctx.body && typeof ctx.body.get === 'function' ? ctx.body.get('file') : null;
    if (!file) throw new AppError(ERR.VALIDATION_ERROR, '缺少上传文件（字段名 file）');
    if (!ALLOW_TYPES.includes(file.type)) throw new AppError(ERR.FILE_TYPE_INVALID, '只支持 jpg / png / webp / gif 图片');
    const maxMb = Number(configOr('upload.max_size_mb', ctx.schoolId, 5));
    if (Number(file.size) > maxMb * 1024 * 1024) {
      throw new AppError(ERR.FILE_TOO_LARGE, '图片体积超过 ' + maxMb + 'MB，请压缩后重试');
    }
    const url = await fileToDataUrl(file);
    return { url, size: Number(file.size), mimetype: file.type, storage: 'demo-inline' };
  }, { message: '上传成功' });
}
