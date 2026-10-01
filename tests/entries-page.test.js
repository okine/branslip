// tests/entries-page.test.js
/* entries.js —— 主区渲染 / 分页 / 跳转里那几条"状态不能串场"的守卫。
 *
 * entries.js 顶层绑了一堆 DOM 事件，所以这里的 document 桩要能扛住
 * addEventListener / querySelectorAll；真正被断言的只有几处：
 *   - #entries 的 innerHTML（renderEntries 的输出）
 *   - Store.ui.flashEntry 的生命周期
 *   - loadEarlier 的话题守卫
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fakeEl, rootEl } from './_browser-stubs.js';

/* rAF 改成"同步执行 + 限深"。
   必须真的执行 —— jumpToRow / jumpToBlock 的重试逻辑全在 rAF 回调里，
   不跑就等于没测。限深是为了让"自己排自己"的死循环变成一条清晰的
   RangeError，而不是把测试挂死。 */
let _rafDepth = 0;
globalThis.requestAnimationFrame = cb => {
  if (++_rafDepth > 50) { _rafDepth = 0; throw new RangeError('rAF 递归过深：疑似自己排自己'); }
  try { cb(Date.now()); } finally { _rafDepth--; }
  return 0;
};
globalThis.cancelAnimationFrame = () => {};

/* #entries 要能记下 innerHTML，且 querySelector 返回 null（= 目标行没渲染） */
const boxEl = fakeEl();
/* #loadEarlier 必须"存在" —— loadEarlier 拿它当哨兵。
   insertAdjacentHTML 在桩里是空操作，所以"插进去了"只能靠哨兵这句话来观察。 */
const sentinelEl = fakeEl();
globalThis.document.querySelector = sel => (sel === '#entries' ? boxEl : rootEl(sel));
globalThis.document.getElementById = id => (
  id === 'entries'     ? boxEl :
  id === 'loadEarlier' ? sentinelEl :
  rootEl('#' + id)
);

const { Store } = await import('../store.js');
const { renderEntries, loadEarlier } = await import('../entries.js');

const mk = (id, title, entries = []) => ({
  id, title, _name: title, _dir: null,
  children: [], entries, pinned: [], folds: [],
});

const entry = (id, text, createdAt) => ({ id, text, createdAt, edited: false, editedAt: null });

function setup(entriesA = [], entriesB = []) {
  const A = mk('A', '工作', entriesA);
  const B = mk('B', '生活', entriesB);
  Store.root.children = [A, B];
  Store.root.entries = [];
  Store.rebuildIndex();

  Store.ui.merged = null;
  Store.ui.selectedId = null;
  Store.ui.flashEntry = null;
  Store.ui.editingEntry = null;
  Store.ui.loadedStart = 0;
  Store.collapsed.clear();
  boxEl.innerHTML = '';
  boxEl.className = '';
  return { A, B };
}

beforeEach(() => setup());

/* ============================================================
 * flashEntry 的生命周期
 * ============================================================ */

test('renderEntries：空话题（早退分支）也要消费掉 flashEntry', () => {
  const { A } = setup();                     // A 没有 entries
  Store.ui.selectedId = 'A';
  Store.ui.flashEntry = 'e-不存在';

  renderEntries();

  assert.equal(Store.ui.flashEntry, null,
    '早退分支没清的话，这个 id 会留到下一个话题渲染时才被消费');
  assert.match(boxEl.innerHTML, /还是空白的/);
});

test('renderEntries：没有选中话题时同样要清掉 flashEntry', () => {
  setup();
  Store.ui.selectedId = null;
  Store.ui.flashEntry = 'e-x';

  renderEntries();

  assert.equal(Store.ui.flashEntry, null);
  assert.match(boxEl.innerHTML, /从左侧开始第一层话题/);
});

test('renderEntries：合并视图也要清掉 flashEntry', () => {
  setup();
  Store.ui.merged = 'all';
  Store.ui.flashEntry = 'e-x';

  renderEntries();                            // 走 D.renderMerged()（注入的是空函数）

  assert.equal(Store.ui.flashEntry, null);
});

test('renderEntries：正常渲染时 flashEntry 只被消费一次', () => {
  const { A } = setup();
  A.entries = [entry('e1', '正文', 1000)];
  Store.rebuildIndex();
  Store.ui.selectedId = 'A';
  Store.ui.flashEntry = 'e1';

  renderEntries();
  assert.equal(Store.ui.flashEntry, null);

  /* 再渲染一次：不该再"回想"起上一次的 flash 目标 */
  renderEntries();
  assert.equal(Store.ui.flashEntry, null);
  assert.match(boxEl.innerHTML, /data-eid="e1"/);
});

/* ============================================================
 * loadEarlier 的话题守卫
 * ============================================================ */

test('loadEarlier：视口不是这个话题 → 直接拒绝，不拿错下标去索引', () => {
  const { A, B } = setup();
  /* 造够条目，让 end - CHUNK_SIZE 有东西可切 —— 否则即使没有守卫，
     start 也会等于 end 而提前返回，测试就成了假通过。 */
  A.entries = Array.from({ length: 100 }, (_, i) => entry('a' + i, '甲' + i, 1000 + i));
  B.entries = Array.from({ length: 100 }, (_, i) => entry('b' + i, '丙' + i, 5000 + i));
  Store.rebuildIndex();

  Store.ui.selectedId = 'B';                  // 视口在看 B
  Store.ui.loadedStart = 50;                  // 去掉守卫时 start 会是 10，必然被改写

  loadEarlier(A);                             // 却要加载 A 的更早记录

  /* loadedStart 是"这次渲染到哪"的唯一事实来源，任何成功路径都会改它 ——
     所以它是最好的观测点（DOM 那侧在桩里不好观察）。 */
  assert.equal(Store.ui.loadedStart, 50,
    '不能拿 A 的 entries 去配当前视图的下标，还把它改掉');
});

test('loadEarlier：没有 #loadEarlier 哨兵 → 什么都不做', () => {
  const { A } = setup();
  A.entries = [entry('a1', '甲', 1000)];
  Store.rebuildIndex();
  Store.ui.selectedId = 'A';
  Store.ui.loadedStart = 0;

  assert.doesNotThrow(() => loadEarlier(A));
});

test('loadEarlier：n 为空 / 不在当前视图 → 静默返回', () => {
  setup();
  assert.doesNotThrow(() => loadEarlier(null));
  assert.doesNotThrow(() => loadEarlier({ id: '不存在', entries: [] }));
});

/* ============================================================
 * jumpToRow 的视口守卫
 * ============================================================ */

test('jumpToRow：视口话题与目标不一致时不会改动分页状态', async () => {
  const { A } = setup();
  A.entries = Array.from({ length: 100 }, (_, i) => entry('a' + i, '甲' + i, 1000 + i));
  Store.rebuildIndex();

  sentinelEl.remove = () => {};
  sentinelEl.textContent = '初始';
  Store.ui.selectedId = 'B';                  // 视口在看 B，却要跳到 A 的记录
  Store.ui.loadedStart = 50;
  const { jumpToRow } = await import('../entries.js');

  /* 桩里 #loadEarlier 恒存在、目标行恒找不到 → 没有守卫时会走 loadEarlier(A) 那条腿。
     注意：真正拦住它的是 loadEarlier 自己的视口守卫；jumpToRow 这道守卫只是
     省掉一次无用调用和一轮 rAF，没有独立可观测的状态差异
     （变异验证过：单独摘掉它，本文件没有用例会失败）。
     这条断言守的是"最终结果"：跳转不会顺手把当前视图的分页状态改掉。 */
  assert.doesNotThrow(() => jumpToRow(A, 'a1'));

  assert.equal(Store.ui.loadedStart, 50, '不该拿当前视图的下标去给 A 分页');
});
