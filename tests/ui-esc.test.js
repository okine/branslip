// tests/ui-esc.test.js
'use strict';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ui-esc 段可以先抽出来，或者直接从 ui.js import
// 如果还在 ui.js 里，需要 mock document 让顶层不报错
globalThis.document = globalThis.document || {
  querySelector: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
  body: { appendChild() {} },
};

const { makeEscapable, runTopEsc, hasEscapable } = await import('../ui.js');

/* 每次测试前清空栈。
   注意：handler 可能抛错（本文件就有一条专门测这个），所以不能裸 while —— 
   抛错时后面的条目会留着，漏进下一条用例。 */
function drain() {
  for (let i = 0; i < 100; i++) {
    try { if (!runTopEsc()) break; } catch (e) { /* 忽略：继续排空 */ }
  }
}
beforeEach(drain);

test('makeEscapable：close() 调一次 closeFn', () => {
  let n = 0;
  const close = makeEscapable(() => n++);
  close();
  assert.equal(n, 1);
});

test('makeEscapable：重复调 close() 只执行一次（幂等）', () => {
  let n = 0;
  const close = makeEscapable(() => n++);
  close(); close(); close();
  assert.equal(n, 1);
});

test('runTopEsc：后开的先关（栈顶优先）', () => {
  const order = [];
  makeEscapable(() => order.push('a'));
  makeEscapable(() => order.push('b'));
  makeEscapable(() => order.push('c'));

  runTopEsc();     // 关 c
  runTopEsc();     // 关 b
  runTopEsc();     // 关 a
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('runTopEsc：栈空返回 false', () => {
  assert.equal(hasEscapable(), false);
  assert.equal(runTopEsc(), false);
});

test('runTopEsc：非栈顶 close 之后，栈里剩的仍是"活"的', () => {
  let aClosed = false, bClosed = false;
  const closeA = makeEscapable(() => { aClosed = true; });
  makeEscapable(() => { bClosed = true; });

  closeA();                 // 手动关 A（弹出栈中间的项）
  assert.equal(aClosed, true);
  assert.equal(bClosed, false);

  runTopEsc();              // 只剩 B
  assert.equal(bClosed, true);
});

test('runTopEsc：一个 handler 抛错不影响后续', () => {
  /* 后开的先关：LIFO ⇒ 先跑 second（不抛），再跑抛错的那条。
     重点不是"第一次就抛"，而是：
       - 抛错被抛给调用方（Escape 分发能看见）
       - 抛错的那条已经先出栈了，不会卡住后面的条目 */
  const ran = [];
  makeEscapable(() => { ran.push('err'); throw new Error('boom'); });
  makeEscapable(() => { ran.push('second'); });

  assert.equal(runTopEsc(), true);
  assert.deepEqual(ran, ['second'], '先处理栈顶');

  assert.throws(() => runTopEsc(), /boom/, '抛错要抛给调用方');
  assert.deepEqual(ran, ['second', 'err']);

  assert.equal(hasEscapable(), false, '两条都出栈了，不能留僵尸');
});

test('runTopEsc：handle 过的条目一定出栈（回归）', () => {
  /* 老实现里 runTopEsc 自己不出栈，而 makeEscapable 的 close() 第二次会
     直接 return —— 于是被 Escape 跑过的条目永远留在栈上，
     hasEscapable() 从此恒为 true，app.js 的 Escape 分发全被带偏。
     触发路径：条目先被别的路径关过，再被 Escape 命中。 */
  let n = 0;
  const close = makeEscapable(() => n++);

  close();                              // 主动关：跑 closeFn，出栈
  assert.equal(n, 1);
  assert.equal(hasEscapable(), false, 'close() 之后必须出栈');
  close();                              // 幂等
  assert.equal(n, 1);

  /* 这次先让别的路径把它关掉（active → false），再让 Escape 命中：
     handler 应当是 no-op，且**不能**把栈里下面那条误摘掉 */
  const keeper = makeEscapable(() => n++);
  const dormant = makeEscapable(() => {});
  dormant();                            // dormant 出栈，keeper 还在
  assert.equal(hasEscapable(), true);

  runTopEsc();                          // 命中 keeper（栈顶）
  assert.equal(n, 2);
  assert.equal(hasEscapable(), false);
});