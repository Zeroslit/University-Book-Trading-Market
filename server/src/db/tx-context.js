// 事务上下文（AsyncLocalStorage）
// 目的：事务执行期间，任何通过 pool.js 的 query/execute 都会自动复用同一连接，
//       避免「事务持有连接 + 内部再向连接池要连接」导致的连接池耗尽死锁。
// 独立成模块是为了避免 pool.js 与 tx.js 之间的循环依赖。
import { AsyncLocalStorage } from 'node:async_hooks';

export const txStorage = new AsyncLocalStorage();

export function currentTx() {
  return txStorage.getStore() ?? null;
}

export function runInTx(conn, handler) {
  return txStorage.run(conn, handler);
}
