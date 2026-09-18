// 单元测试：脱敏与状态机（纯函数，不依赖数据库）
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskPhone, maskStudentNo, maskBankCard, maskName, maskEmail, maskMatch, maskSegments } from '../../src/lib/mask.js';
import { canTransition, nextStates, isTerminal, assertTransition, assertAffected } from '../../src/lib/state-machine.js';
import { AppError, ERR } from '../../src/lib/errors.js';

// 捕获异常对象（assert.throws 不返回异常实例）
function capture(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

test('脱敏：手机号/学号/银行卡/姓名/邮箱', () => {
  assert.equal(maskPhone('13800138000'), '138****8000');
  assert.equal(maskStudentNo('2021010101'), '20******01');
  assert.equal(maskBankCard('6222021234567890123'), '***************0123');
  assert.equal(maskName('林晓'), '林*');
  assert.equal(maskEmail('zhangsan@example.com'), 'zh******@example.com');
  assert.equal(maskPhone('123'), '****');
});

test('打码：按命中片段替换，不改变未命中部分', () => {
  assert.equal(maskMatch('13800138000'), '1*********0');
  const text = '微信是 abc12345';
  const masked = maskSegments(text, [{ start: 5, end: 12 }]);
  assert.equal(masked.length, text.length);
  assert.ok(!masked.includes('abc12345'));
});

test('状态机：正常流转与非法流转', () => {
  const machine = {
    initial: 'pending_payment',
    terminal: ['completed', 'cancelled', 'refunded'],
    transitions: {
      pending_payment: ['paid', 'cancelled'],
      paid: ['shipped', 'refund_requested', 'disputed'],
      shipped: ['completed', 'return_requested', 'disputed'],
      refund_requested: ['refunded', 'paid', 'disputed'],
      completed: [], cancelled: [], refunded: [],
    },
  };
  assert.equal(canTransition(machine, 'pending_payment', 'paid'), true);
  assert.equal(canTransition(machine, 'pending_payment', 'shipped'), false);
  assert.deepEqual(nextStates(machine, 'paid'), ['shipped', 'refund_requested', 'disputed']);
  assert.equal(isTerminal(machine, 'completed'), true);
  assert.equal(isTerminal(machine, 'paid'), false);
  assert.equal(assertTransition(machine, 'paid', 'shipped', '订单'), true);

  const err = capture(() => assertTransition(machine, 'completed', 'paid', '订单'));
  assert.ok(err instanceof AppError);
  assert.equal(err.code, ERR.ORDER_STATE_INVALID);
  assert.deepEqual(err.details.allowed, []);
});

test('状态机：乐观锁影响行数为 0 时必须报错（防并发覆盖）', () => {
  assert.equal(assertAffected(1), true);
  const err = capture(() => assertAffected(0, ERR.ORDER_STATE_INVALID, '订单状态已变更'));
  assert.equal(err.code, ERR.ORDER_STATE_INVALID);
});
