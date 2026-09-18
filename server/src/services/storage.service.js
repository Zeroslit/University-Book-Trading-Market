// 图片存储适配器：一期存本地目录，二期可切换对象存储（OSS/COS）
// 约定：前端已把长边压缩到 ≤1080px，库里只存 URL
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { AppError, ERR } from '../lib/errors.js';

const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export const storageService = {
  get baseDir() {
    return path.resolve(process.cwd(), config.upload.dir);
  },

  async saveImage({ buffer, mimetype, size }) {
    if (!config.upload.allowTypes.includes(mimetype)) {
      throw new AppError(ERR.FILE_TYPE_INVALID, `不支持的图片类型：${mimetype}，仅支持 JPG/PNG/WebP`);
    }
    const bytes = size ?? buffer?.length ?? 0;
    if (bytes > config.upload.maxSizeMb * 1024 * 1024) {
      throw new AppError(ERR.FILE_TOO_LARGE, `图片不能超过 ${config.upload.maxSizeMb}MB，请压缩后重试`);
    }
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.baseDir, day);
    await fs.mkdir(dir, { recursive: true });
    const filename = `${crypto.randomUUID()}${EXT_BY_TYPE[mimetype] || '.jpg'}`;
    await fs.writeFile(path.join(dir, filename), buffer);
    return { url: `${config.upload.publicBase}/${day}/${filename}`, size: bytes, mimetype };
  },

  // 二期对象存储适配点
  async saveToOss(/* { buffer, mimetype } */) {
    throw new AppError(ERR.DEPENDENCY_UNAVAILABLE, '对象存储尚未接入，请使用本地存储');
  },
};
