// 图片上传路由：/api/v1/uploads
// 前端负责把长边压缩到 ≤1080px；服务端只做类型/体积校验与落盘，库里只存 URL
import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok } from '../../lib/response.js';
import { ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { storageService } from '../../services/storage.service.js';
import { config } from '../../config/index.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxSizeMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!config.upload.allowTypes.includes(file.mimetype)) {
      return cb(new Error('UNSUPPORTED_TYPE'));
    }
    return cb(null, true);
  },
});

export const uploadsRouter = Router();
ensureNumericId(uploadsRouter);

uploadsRouter.post('/image', authenticate, rateLimit('publish'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new Error('缺少上传文件（字段名 file）');
  const saved = await storageService.saveImage({
    buffer: req.file.buffer, mimetype: req.file.mimetype, size: req.file.size,
  });
  return ok(res, saved, '上传成功');
}));
