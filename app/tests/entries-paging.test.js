// tests/entries-paging.test.js
/* 向上 / 向下分页加载的"流畅度"回归测试。
 *
 * 覆盖三件以前真出过问题的事：
 *   1. 连加载 N 批后，#loadEarlier 必须还在列表第一位
 *      （老 bug：插在哨兵前面 → 哨兵一路下沉 → 再也加载不出来）
 *   2. loadedStart / loadedEnd 单调推进，到端点时哨兵被移除
 *   3. 加载前后"视口顶部那条记录"的屏幕位置不变（滚动不跳）
 *
 * 用极简假 DOM 驱动真实的 loadEarlier / loadLater，不 mock 被测代码。
 */
import './_browser-stubs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerEl } from './_browser-stubs.js';

const ROW_H = 100;       /* 每行高度（含日期条），用于模拟布局 */
const VIEW_H = 600;      /* 视口高度 */

/* ---------- 假 DOM ---------- */

function makeRow() {
  const row = {
    kind: 'row',
    dataset: {},
    isConnected: true,
    parentNode: null,
    classList: {
      contains: c => c === 'entry-row',
    },
    getBoundingClientRect() {
      const box = row.parentNode;
      const i = box ? box.children.indexOf(row) : 0;
      const top = i * ROW_H - (box ? box.scrollTop : 0);
      return { top, bottom: top + ROW_H - 8, left: 0, right: 0, width: 0, height: ROW_H - 8 };
    },
    remove() {
      const box = row.parentNode;
      if (!box) return;
      const i = box.children.indexOf(row);
      if (i >= 0) box.children.splice(i, 1);
      row.parentNode = null;
      row.isConnected = false;
      box.recalcHeight();
    },
  };
  return row;
}

function makeScroll() {
  const sc = {
    id: 'entriesScroll',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: VIEW_H,
    isConnected: true,
    getBoundingClientRect: () => ({ top: 0, bottom: VIEW_H, left: 0, right: 0, width: 800, height: VIEW_H }),
    style: { scrollBehavior: '' },          /* setScrollTopInstant 会临时改它 */
    scrollTo(opts) { sc.scrollTop = Math.max(0, opts && opts.top != null ? opts.top : sc.scrollTop); },
  };
  return sc;
}

function makeContainer(sc) {
  const box = {
    id: 'entries',
    isConnected: true,
    children: [],
    scrollTop: 0,
    classList: { contains: () => false, add() {}, remove() {} },
    get firstElementChild() { return box.children[0] || null; },
    get firstChild() { return box.children[0] || null; },
    get lastElementChild() { return box.children[box.children.length - 1] || null; },
    get childElementCount() { return box.children.length; },
    get scrollTop_() { return sc.scrollTop; },

    recalcHeight() {
      box.scrollHeight = box.children.length * ROW_H;
      sc.scrollHeight = box.scrollHeight;
    },
    insertBefore(node, ref) {
      const from = box.children.indexOf(node);
      if (from >= 0) box.children.splice(from, 1);
      const at = ref ? box.children.indexOf(ref) : box.children.length;
      box.children.splice(at < 0 ? box.children.length : at, 0, node);
      node.parentNode = box;
      node.isConnected = true;
      box.recalcHeight();
    },
    insertAdjacentHTML(pos, html) {
      /* 只当作"插入了若干行"：测试只关心顺序和高度，不解析 HTML */
      const n = (String(html).match(/data-eid=/g) || []).length || 1;
      const box2 = box;
      const anchorIdx = (() => {
        if (pos === 'afterbegin') return 0;
        return box2.children.indexOf(null);   /* 占位，下面按 pos 覆盖 */
      })();
      void anchorIdx;
      const rows = Array.from({ length: n }, makeRow);
      for (const r of rows) { r.parentNode = box2; r.isConnected = true; }
      if (pos === 'afterbegin') box2.children.unshift(...rows);
      else if (pos === 'beforeend') box2.children.push(...rows);
      else box2.children.push(...rows);
      box2.recalcHeight();
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    getBoundingClientRect: () => ({ top: 0, bottom: box.scrollHeight || 0, left: 0, right: 0, width: 800, height: box.scrollHeight || 0 }),
  };
  return box;
}

/* 哨兵：自己也是 children 的一员，但不是 entry-row */
function makeSentinel(id) {
  const el = {
    id,
    kind: 'sentinel',
    dataset: {},
    textContent: '',
    isConnected: true,
    parentNode: null,
    className: 'load-earlier',
    classList: {
      contains: c => c === 'load-earlier',
      add() {}, remove() {}, toggle() {},
    },
    getBoundingClientRect() {
      const box = el.parentNode;
      const i = box ? box.children.indexOf(el) : 0;
      const top = i * ROW_H - (box ? box.scrollTop : 0);
      return { top, bottom: top + 30, left: 0, right: 0, width: 800, height: 30 };
    },
    insertAdjacentHTML(pos, html) {
      const box = el.parentNode;
      if (!box) return;
      const n = (String(html).match(/data-eid=/g) || []).length || 1;
      const rows = Array.from({ length: n }, makeRow);
      for (const r of rows) { r.parentNode = box; r.isConnected = true; }
      const i = box.children.indexOf(el);
      if (pos === 'afterend') box.children.splice(i + 1, 0, ...rows);
      else if (pos === 'beforebegin') box.children.splice(i, 0, ...rows);
      else if (pos === 'afterbegin') box.children.unshift(...rows);
      else box.children.push(...rows);
      box.recalcHeight();
    },
    remove() {
      const box = el.parentNode;
      if (!box) return;
      const i = box.children.indexOf(el);
      if (i >= 0) box.children.splice(i, 1);
      el.parentNode = null;
      el.isConnected = false;
      box.recalcHeight();
    },
    addEventListener() {},
  };
  return el;
}

/* 让 box 里的行按当前 scrollTop 画；模拟浏览器 */
function paint(box, sc) {
  box.scrollTop = sc.scrollTop;
}

/* ---------- 造数据 ---------- */

const HOUR = 3600 * 1000;
const BASE = Date.UTC(2026, 8, 1, 12, 0, 0);

function makeNode(count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      id: 'e' + i,
      text: '第 ' + i + ' 条',
      createdAt: BASE + i * HOUR,
      edited: false,
      editedAt: null,
    });
  }
  return { id: 'topic-1', title: '话题', _dir: 'E:/tmp', entries, children: [] };
}

/* ---------- 搭场景 ---------- */

async function setup({ total, loadedStart, loadedEnd, rows }) {
  const { Store } = await import('../store.js');
  const jump = await import('../entries-jump.js');

  const sc = makeScroll();
  const box = makeContainer(sc);
  const sentinelTop = makeSentinel('loadEarlier');
  const sentinelBottom = makeSentinel('loadLater');

  const node = makeNode(total);

  /* 初始 DOM：[哨兵][若干行][尾哨兵] —— 和 renderEntries 的顺序一致 */
  box.children.push(sentinelTop);
  sentinelTop.parentNode = box;
  for (let i = 0; i < rows; i++) {
    const r = makeRow();
    r.parentNode = box;
    box.children.push(r);
  }
  if (loadedEnd < total) {
    box.children.push(sentinelBottom);
    sentinelBottom.parentNode = box;
  }
  box.recalcHeight();

  registerEl('#entries', box);
  registerEl('#entriesScroll', sc);
  registerEl('#loadEarlier', sentinelTop);
  registerEl('#loadLater', sentinelBottom);

  globalThis.document.getElementById = id => {
    if (id === 'entries') return box;
    if (id === 'entriesScroll') return sc;
    if (id === 'loadEarlier') return sentinelTop.isConnected ? sentinelTop : null;
    if (id === 'loadLater') return sentinelBottom.isConnected ? sentinelBottom : null;
    return null;
  };

  Store.root.children = [node];
  Store.rebuildIndex();
  Store.ui.selectedId = node.id;
  Store.ui.merged = null;
  Store.ui.loadedStart = loadedStart;
  Store.ui.loadedEnd = loadedEnd;

  return { Store, jump, box, sc, node, sentinelTop, sentinelBottom };
}

/* ---------- 用例 ---------- */

test('向上连续加载 3 批：#loadEarlier 始终是第一个元素，计数单调递减', async () => {
  const { Store, jump, box, sc, node, sentinelTop } = await setup({
    total: 400, loadedStart: 320, loadedEnd: 400, rows: 80,
  });
  paint(box, sc);

  for (const expect of [280, 240, 200]) {
    jump.loadEarlier(node);
    assert.equal(Store.ui.loadedStart, expect, 'loadedStart 应每次减 chunk');
    assert.equal(box.firstElementChild, sentinelTop, '哨兵必须还在第一位（老 bug 回归）');
    assert.ok(sentinelTop.textContent.includes(String(expect)), '哨兵文案要跟着变');
  }
});

test('向上加载到最早一条：loadedStart=0 且哨兵被移除', async () => {
  const { Store, jump, box, node, sentinelTop } = await setup({
    total: 120, loadedStart: 40, loadedEnd: 120, rows: 1,
  });
  paint(box, 0);

  jump.loadEarlier(node);
  assert.equal(Store.ui.loadedStart, 0, '已到最早一条');
  assert.equal(sentinelTop.isConnected, false, '到端点后哨兵要移除');
});

test('向上加载：视口顶部那条记录的屏幕位置保持不变（滚动不跳）', async () => {
  const { jump, box, sc, node } = await setup({
    total: 400, loadedStart: 320, loadedEnd: 400, rows: 80,
  });
  /* 先滚到中间：视口顶部落在某一行上 */
  sc.scrollTop = 1200;
  paint(box, sc);

  const firstRow = box.children.find(el => el.classList.contains('entry-row'));
  const before = firstRow.getBoundingClientRect().top;

  jump.loadEarlier(node);
  paint(box, sc);

  const after = firstRow.getBoundingClientRect().top;
  assert.ok(Math.abs(after - before) <= 1,
    '插入 40 行后同一行的屏幕位置应保持不变：before=' + before + ' after=' + after);
  assert.ok(sc.scrollTop > 1200, 'scrollTop 应被补偿抬高，而不是停在原处');
});

test('向下连续加载 2 批：#loadLater 始终是最后一个元素，loadedEnd 到达总数后移除', async () => {
  const { Store, jump, box, node, sentinelBottom } = await setup({
    total: 400, loadedStart: 240, loadedEnd: 320, rows: 80,
  });

  jump.loadLater(node);
  assert.equal(Store.ui.loadedEnd, 360);
  assert.equal(box.lastElementChild, sentinelBottom, '尾哨兵必须还在最后');

  jump.loadLater(node);
  assert.equal(Store.ui.loadedEnd, 400);
  assert.equal(sentinelBottom.isConnected, false, '到底后尾哨兵移除');
});

test('向下加载：视口顶部那条记录的屏幕位置保持不变', async () => {
  const { jump, box, sc, node } = await setup({
    total: 400, loadedStart: 240, loadedEnd: 320, rows: 80,
  });
  sc.scrollTop = 900;
  paint(box, sc);

  const firstRow = box.children.find(el => el.classList.contains('entry-row'));
  const before = firstRow.getBoundingClientRect().top;

  jump.loadLater(node);
  paint(box, sc);

  const after = firstRow.getBoundingClientRect().top;
  assert.ok(Math.abs(after - before) <= 1,
    '向下追加不应移动现有行：before=' + before + ' after=' + after);
});

test('上下交替加载：两侧哨兵位置都正确，且不会互相污染', async () => {
  const { Store, jump, box, node, sentinelTop, sentinelBottom } = await setup({
    total: 600, loadedStart: 240, loadedEnd: 320, rows: 80,
  });

  jump.loadEarlier(node);
  jump.loadEarlier(node);
  jump.loadLater(node);
  jump.loadEarlier(node);
  jump.loadLater(node);

  assert.equal(Store.ui.loadedStart, 120, '向上 3 批');
  assert.equal(Store.ui.loadedEnd, 400, '向下 2 批');
  assert.equal(box.firstElementChild, sentinelTop, '上哨兵仍在第一位');
  assert.equal(box.lastElementChild, sentinelBottom, '下哨兵仍在最后一位');
});
