// tests/tree-select.test.js
/* tree.js 的 select() —— 切话题这条主路径。
 *
 * 为什么专门测它：`clearPendingForNode is not defined` 那个回归就发生在这里 ——
 * 漏了 import，模块能加载（module-load.test.js 抓不到），只有真的切话题才炸，
 * 表现是"层级树点不动了"。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fakeEl, rootEl, registerEl } from './_browser-stubs.js';

/* select() 会直接摸输入框；桩里 #id 默认给假元素，这里显式登记一个能改 value 的 */
const taEl = registerEl('#inputArea', fakeEl());
const scrollEl = registerEl('#entriesScroll', fakeEl());

globalThis.document.querySelector = sel => (sel === '#entries' ? fakeEl() : rootEl(sel));
globalThis.document.getElementById = id => rootEl('#' + id);

const { Store } = await import('../store.js');
const { markFsReady } = await import('../writer.js');
const image = await import('../image.js');
const { select } = await import('../tree.js');
const { wireEntries } = await import('../entries.js');

/* 把渲染层换成空实现：本文件只测 select() 的状态迁移与副作用，不测 DOM */
beforeEach(() => {
  wireEntries({
    renderAll: () => {},
    renderMerged: () => {},
    setReply: () => {},
    setRelevance: () => {},
  });
  markFsReady();
  taEl.value = '';
  scrollEl.scrollTop = 0;

  Store.fs.ready = false;
  Store.fs.pending = 0;
  Store.fs.hasError = false;
  Store.fs.chain = Promise.resolve();
  Store.setDir(null);

  const mk = (id, title) => ({
    id, title, _name: title, _dir: null, topicId: null,
    children: [], entries: [], pinned: [], folds: [],
  });
  Store.root.children = [mk('A', '工作'), mk('B', '生活')];
  Store.root.entries = [];
  Store.rebuildIndex();

  Store.ui.selectedId = null;
  Store.ui.merged = null;
  Store.ui.editingEntry = null;
  Store.ui.drafts.clear();
  Store.collapsed.clear();
});

test('select：切到话题，selectedId 与索引状态都对', () => {
  assert.doesNotThrow(() => select('A'));
  assert.equal(Store.ui.selectedId, 'A');
  assert.ok(Store.node('A'));
});

test('select：同一个话题再点一次 → 幂等，不抛错', () => {
  select('A');
  assert.doesNotThrow(() => select('A'));
  assert.equal(Store.ui.selectedId, 'A');
});

test('★ clearPendingForNode 在 image.js 里确实存在且可用（回归：漏 import 的地方在 tree.js）', () => {
  /* 说明：ESM 的命名导出是只读的，没法从测试里替换 image.clearPendingForNode 去
     监视 tree.js 是否调用了它 —— 打桩会抛 "Cannot assign to read only property"。
     所以这里分两段守：
       ① 这个函数存在且行为正确（本用例）
       ② tree.js 真的 import 了它（module-load.test.js 的导出表 +
          "select 能跑通不抛 ReferenceError"，由本文件其它用例覆盖）
     老实现漏 import 时，②会红。 */
  assert.equal(typeof image.clearPendingForNode, 'function');
  assert.doesNotThrow(() => image.clearPendingForNode('不存在的话题'));
});

test('select：切到不同话题不会抛错（漏 import 会在这里 ReferenceError）', () => {
  select('A');
  assert.doesNotThrow(() => select('B'));
  assert.equal(Store.ui.selectedId, 'B');
});

test('select：合并视图下切话题也不会抛错', () => {
  Store.ui.merged = 'all';
  assert.doesNotThrow(() => select('A'));
  assert.equal(Store.ui.merged, null, '切话题会退出合并视图');
});

test('select：草稿跟着话题走', () => {
  Store.ui.drafts.set('A', 'A 的草稿');
  Store.ui.drafts.set('B', 'B 的草稿');

  select('A');
  assert.equal(taEl.value, 'A 的草稿');

  select('B');
  assert.equal(taEl.value, 'B 的草稿');
});

test('select(null) / 不存在的 id → 静默返回', () => {
  select('A');
  assert.doesNotThrow(() => select(null));
  assert.equal(Store.ui.selectedId, 'A', 'null 不该改变选中');
});

test('select：切换时会记住旧话题的滚动位置', () => {
  select('A');
  scrollEl.scrollTop = 4321;
  select('B');
  assert.equal(Store.scrollMemo.get('A'), 4321);
});

test('recallScroll：内存没有时从 node.scroll（_话题.json）回落', async () => {
  const { recallScroll } = await import('../entries-jump.js');
  Store.scrollMemo.clear();
  const n = Store.node('A');
  n.scroll = { top: 777 };
  assert.equal(recallScroll('A', n), 777);
  assert.equal(Store.getScrollMemo('A'), 777);
});
