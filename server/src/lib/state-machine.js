// 配置驱动的状态机：迁移表来自 configs（禁止把分支写死在业务代码里）
import { AppError, ERR } from './errors.js';

export function canTransition(machine, from, to) {
  if (!machine || !machine.transitions) return false;
  const allowed = machine.transitions[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function nextStates(machine, from) {
  if (!machine || !machine.transitions) return [];
  return machine.transitions[from] || [];
}

export function isTerminal(machine, state) {
  if (!machine) return false;
  if (Array.isArray(machine.terminal)) return machine.terminal.includes(state);
  return nextStates(machine, state).length === 0;
}

export function assertTransition(machine, from, to, label = '状态') {
  if (!canTransition(machine, from, to)) {
    throw new AppError(
      ERR.ORDER_STATE_INVALID,
      `${label}不允许从「${from}」变更为「${to}」`,
      { from, to, allowed: nextStates(machine, from) },
    );
  }
  return true;
}

// 乐观锁式条件更新的统一写法：UPDATE ... WHERE status = ? 并检查影响行数
export function assertAffected(affectedRows, code = ERR.ORDER_STATE_INVALID, message = '操作冲突，状态已变更') {
  if (!affectedRows) throw new AppError(code, message);
  return true;
}
