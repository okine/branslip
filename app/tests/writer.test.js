// tests/writer.test.js
globalThis.DOMException = globalThis.DOMException ||
  class extends Error { constructor(msg, name) { super(msg); this.name = name || 'Error'; } };
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* writer.js 的 catch 分支会调 ui.js:toast()，
   toast 需要 document.createElement + #toastRoot。
   setStatus 里 #saveDot 为 null 会提前返回，所以 saveDot/saveText 返回 null 即可。 */
   function fakeEl() {
    return {
      className: '',
      textContent: '',
      title: '',
      innerHTML: '',
      value: '',
      disabled: false,
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => fakeEl(),
      querySelectorAll: () => [],
      focus() {},
      click() {},
      dispatchEvent() {},
    };
  }
  globalThis.document = {
    querySelector: sel => (sel === '#toastRoot' || sel === '#modalRoot' ? fakeEl() : null),
    createElement: () => fakeEl(),
    body: fakeEl(),
    addEventListener() {},
    removeEventListener() {},
  };
const { Store } = await import('../store.js');
const { enqueue, setStatus, markFsReady, beginBusy, endBusy } = await import('../writer.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  Store.fs.ready = true;
  Store.fs.pending = 0;
  Store.fs.hasError = false;
  Store.fs.chain = Promise.resolve();
  Store.setDir(null);     /* 权限分支要求 Store.dir 非空，别让上一条用例影响它 */
  Store.root.children = [];
  Store.rebuildIndex();
});

test('enqueue 保证串行：后一个必须等前一个 await 完', async () => {
  const order = [];
  const p1 = enqueue(async () => { await sleep(30); order.push('a'); });
  const p2 = enqueue(async () => { await sleep(5);  order.push('b'); });
  const p3 = enqueue(async () => {                   order.push('c'); });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('enqueue：一个抛错不阻断后续', async () => {
  const order = [];
  const p1 = enqueue(async () => { order.push('a'); throw new Error('boom'); });
  const p2 = enqueue(async () => { order.push('b'); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(Store.fs.hasError, true);
});

test('enqueue：全部完成后 pending 归零', async () => {
  const ps = [];
  for (let i = 0; i < 5; i++) ps.push(enqueue(async () => { await sleep(2); }));
  await Promise.all(ps);
  assert.equal(Store.fs.pending, 0);
});

test('enqueue：未连接时不丢弃 —— 等 markFsReady 后按序执行', async () => {
  Store.fs.ready = false;
  const order = [];

  const p1 = enqueue(() => { order.push('a'); });
  const p2 = enqueue(() => { order.push('b'); });
  await sleep(10);
  assert.deepEqual(order, []);            // 还没有文件夹 → 一个都不能跑

  Store.fs.ready = true;
  markFsReady();
  await Promise.all([p1, p2]);

  assert.deepEqual(order, ['a', 'b']);    // 而且顺序不能乱
  assert.equal(Store.fs.pending, 0);
});

test('enqueue：未连接时任务抛错 → 调用方能拿到结果（不再静默 resolve）', async () => {
  Store.fs.ready = false;

  const handle = enqueue(() => { throw new Error('没有文件夹'); });

  Store.fs.ready = true;
  markFsReady();
  const r = await handle;

  assert.equal(r.ok, false, '失败要能传到调用方');
  assert.equal(r.err.message, '没有文件夹');
  assert.equal(Store.fs.hasError, true);

  /* pending 是 .finally 里减的，而句柄在 .finally 之前就 settle 了，
     所以要等链 —— 这也正是下面那条并发用例能把 pending 读成 6..1 的原因 */
  await Store.fs.chain;
  assert.equal(Store.fs.pending, 0);
  Store.fs.hasError = false;
});

test('enqueue：成功任务的结果是 { ok: true }', async () => {
  const r = await enqueue(() => {});
  assert.equal(r.ok, true);
});

test('enqueue：返回值只代表自己那个任务（不是链）', async () => {
  /* 老实现返回 Store.fs.chain，而 .finally() 会把链的值换成新 Promise，
     于是调用方 await 到的永远是"下一个空 promise" —— 失败传不出去 */
  let secondDone = false;
  const a = enqueue(() => { throw new Error('a 失败'); });
  const b = enqueue(() => { secondDone = true; });

  const ra = await a, rb = await b;
  assert.equal(ra.ok, false, '自己的失败要能收到');
  assert.equal(ra.err.message, 'a 失败');
  assert.equal(rb.ok, true);
  assert.equal(secondDone, true, '而且不阻断后继任务');

  await Store.fs.chain;
  assert.equal(Store.fs.pending, 0);
});

test('enqueue：并发入队时 pending 单调递增再归零', async () => {
  const samples = [];
  const ps = [];
  for (let i = 0; i < 6; i++) {
    ps.push(enqueue(async () => {
      samples.push(Store.fs.pending);
      await sleep(3);
    }));
  }
  await Promise.all(ps);
  // 每一个任务"开始时"读到的 pending 应该是 6,5,4,3,2,1
  assert.deepEqual(samples.sort((a, b) => b - a), [6, 5, 4, 3, 2, 1]);
});

test('enqueue：NoModificationAllowedError 触发权限恢复提示', async () => {
  const { enqueue } = await import('../writer.js');
  const { Store } = await import('../store.js');

  Store.fs.ready = true;
  Store.fs.hasError = false;
  Store.setDir({});   // 非 null

  // 用 spy 拦截 promptPermissionRecovery（需要 export 出来）
  // 简化：断言结果是 { ok:false, err }、hasError 变 true 且 pending 归零
  const err = new DOMException('readonly', 'NoModificationAllowedError');
  const r = await enqueue(async () => { throw err; });

  assert.equal(r.ok, false);
  assert.equal(r.err, err);
  assert.equal(Store.fs.hasError, true);
  await Store.fs.chain;              // pending 在 .finally 里减
  assert.equal(Store.fs.pending, 0);
  Store.setDir(null);
});
test('beginBusy / endBusy：外部操作期间 pending 归零也不回已保存', async () => {
  Store.fs.busyOps = 0;
  beginBusy('正在解析聊天记录');
  assert.equal(Store.fs.busyOps, 1);
  await enqueue(async () => {});
  await Store.fs.chain;              // pending 在 .finally 里减
  assert.equal(Store.fs.pending, 0);
  assert.equal(Store.fs.busyOps, 1, '队列空了但解析还在进行');
  endBusy();
  assert.equal(Store.fs.busyOps, 0);
});
