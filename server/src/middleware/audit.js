// 管理动作审计中间件：成功后自动留痕（谁、何时、对什么、做了什么）
import { auditService } from '../services/audit.service.js';

export function auditAction(action, resolveTarget = () => ({})) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const target = resolveTarget(req) || {};
        auditService.record({
          schoolId: req.schoolId ?? req.user?.schoolId ?? null,
          actorId: req.user?.id ?? null,
          actorRole: req.user?.role ?? null,
          action,
          targetType: target.type ?? null,
          targetId: target.id ?? null,
          detail: { method: req.method, path: req.originalUrl, params: target.params ?? null },
          ip: req.ip,
        });
      }
    });
    next();
  };
}
