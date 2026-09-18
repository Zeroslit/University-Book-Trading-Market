// 演示版直接复用后端 lib（风控归一化、违禁词匹配、脱敏、错误码、状态机、分页）
// 好处：演示环境与真实服务的行为完全一致，避免两套实现漂移
export {
  normalizeText, normalizeWithMap, toOriginalRange, DEFAULT_NORMALIZE_OPTIONS,
} from '../../../server/src/lib/normalize.js';
export { buildMatcher, findHits, filterWhitelist, AhoCorasick } from '../../../server/src/lib/word-matcher.js';
export {
  maskPhone, maskStudentNo, maskBankCard, maskName, maskEmail, maskMatch, maskSegments,
} from '../../../server/src/lib/mask.js';
export {
  AppError, ERR, httpStatusOf, badRequest, unauthorized, forbidden, notFound, conflict, schoolRequired,
} from '../../../server/src/lib/errors.js';
export {
  canTransition, nextStates, isTerminal, assertTransition, assertAffected,
} from '../../../server/src/lib/state-machine.js';
export { parsePagination, parseSort, sortToSql } from '../../../server/src/lib/pagination.js';
