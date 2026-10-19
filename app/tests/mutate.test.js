// tests/mutate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Mutate } from '../mutate.js';

function makeNode() {
  return { entries: [], pinned: [], folds: [] };
}

test('addEntry 追加一条并返回它', () => {
  const n = makeNode();
  const e = Mutate.addEntry(n, { id: 'a1', text: '你好', createdAt: 1000 });

  assert.equal(n.entries.length, 1);
  assert.equal(e.id, 'a1');
  assert.equal(e.text, '你好');
  assert.equal(e.createdAt, 1000);
  assert.equal(e.edited, false);
});

test('editEntry 改文本 → 标记已编辑', () => {
  const n = makeNode();
  Mutate.addEntry(n, { id: 'a1', text: '旧', createdAt: 1000 });

  const r = Mutate.editEntry(n, 'a1', '新');

  assert.equal(r.changed, true);
  assert.equal(n.entries[0].text, '新');
  assert.equal(n.entries[0].edited, true);
  assert.ok(n.entries[0].editedAt, 'editedAt 应该有值');
});

test('editEntry 文本没变 → changed=false', () => {
  const n = makeNode();
  Mutate.addEntry(n, { id: 'a1', text: '一样', createdAt: 1000 });

  const r = Mutate.editEntry(n, 'a1', '一样');

  assert.equal(r.changed, false);
  assert.equal(n.entries[0].edited, false);
});

test('insertSorted 遇到同毫秒 → 顺延，保持顺序', () => {
  const n = makeNode();
  Mutate.addEntry(n, { id: 'a', text: 'A', createdAt: 1000 });
  Mutate.addEntry(n, { id: 'b', text: 'B', createdAt: 2000 });

  Mutate.insertSorted(n, { id: 'x', text: 'X', createdAt: 1000 });

  assert.equal(n.entries.length, 3);
  assert.deepEqual(n.entries.map(e => e.id), ['a', 'x', 'b']);
  assert.equal(n.entries[1].createdAt, 1001);
});

test('togglePin 来回切换', () => {
  const n = makeNode();
  const e = Mutate.addEntry(n, { id: 'a1', text: 'x', createdAt: 1000 });

  assert.equal(Mutate.togglePin(n, e), true);
  assert.equal(Mutate.isPinned(n, e), true);
  assert.deepEqual(n.pinned, [1000]);

  assert.equal(Mutate.togglePin(n, e), false);
  assert.deepEqual(n.pinned, []);
});

test('removeEntry 会顺手清掉它的置顶', () => {
  const n = makeNode();
  const e = Mutate.addEntry(n, { id: 'a1', text: 'x', createdAt: 1000 });
  Mutate.togglePin(n, e);

  const r = Mutate.removeEntry(n, 'a1');

  assert.equal(r.wasPinned, true);
  assert.equal(n.entries.length, 0);
  assert.deepEqual(n.pinned, []);
});

test('addFold 丢弃与之重叠的旧折叠', () => {
  const n = makeNode();
  Mutate.addFold(n, 100, 200);
  Mutate.addFold(n, 150, 300);

  assert.equal(n.folds.length, 1);
  assert.deepEqual(n.folds[0], { from: 150, to: 300 });
});


/* ---------- 查找 ---------- */

test('findEntryById / findEntryIndexById', () => {
  const n = makeNode();
  Mutate.addEntry(n, { id: 'a', text: 'A', createdAt: 1000 });
  Mutate.addEntry(n, { id: 'b', text: 'B', createdAt: 2000 });

  assert.equal(Mutate.findEntryById(n, 'b').text, 'B');
  assert.equal(Mutate.findEntryIndexById(n, 'b'), 1);
  assert.equal(Mutate.findEntryById(n, '缺'), null);
  assert.equal(Mutate.findEntryIndexById(n, '缺'), -1);
});


/* ---------- entryBlockId ---------- */

test('entryBlockId 格式为 YYYY-MM-DD_HH-mm-ss-mmm', () => {
  const n = makeNode();
  const e = Mutate.addEntry(n, {
    id: 'a', text: 'A',
    // ← 关键：用本地构造，本地字段恒为 2026-09-17 09:05:03.007
    createdAt: new Date(2026, 8, 17, 9, 5, 3, 7).getTime(),
  });
  assert.equal(Mutate.entryBlockId(e), '2026-09-17_09-05-03-007');
});

test('entryBlockId 优先用 _writeStamp（跨时区稳定）', () => {
  const n = makeNode();
  const e = Mutate.addEntry(n, {
    id: 'a', text: 'A',
    createdAt: new Date(2026, 8, 17, 9, 5, 3, 7).getTime(),
  });
  // 假装写盘时用的是 +08:00
  e._writeStamp = '2026-09-17 09:05:03.007+08:00';
  assert.equal(Mutate.entryBlockId(e), '2026-09-17_09-05-03-007');
});

test('findEntryIndexByBlockId 用块 ID 反查', () => {
  const n = makeNode();
  const e = Mutate.addEntry(n, {
    id: 'a', text: 'A', createdAt: new Date(2026, 8, 17, 9, 5, 3, 7).getTime(),
  });
  assert.equal(Mutate.findEntryIndexByBlockId(n, Mutate.entryBlockId(e)), 0);
  assert.equal(Mutate.findEntryIndexByBlockId(n, '不存在'), -1);
});

/* ---------- 置顶 ---------- */

test('addPin 同一条不重复加', () => {
  const n = makeNode();
  const e = Mutate.addEntry(n, { id: 'a', text: 'A', createdAt: 1000 });
  assert.equal(Mutate.addPin(n, e), true);
  assert.equal(Mutate.addPin(n, e), false);
  assert.deepEqual(n.pinned, [1000]);
});

test('removePin 对未置顶返回 false', () => {
  const n = makeNode();
  const e = Mutate.addEntry(n, { id: 'a', text: 'A', createdAt: 1000 });
  assert.equal(Mutate.removePin(n, e), false);
});

test('pinnedEntries 按 pinned 顺序返回，跳过已删的', () => {
  const n = makeNode();
  Mutate.addEntry(n, { id: 'a', text: 'A', createdAt: 1000 });
  Mutate.addEntry(n, { id: 'b', text: 'B', createdAt: 2000 });
  Mutate.addEntry(n, { id: 'c', text: 'C', createdAt: 3000 });
  n.pinned = [3000, 1000, 9999];        // 9999 不存在

  const list = Mutate.pinnedEntries(n).map(e => e.id);
  assert.deepEqual(list, ['c', 'a']);
});

test('pinnedEntries 空 pinned 返回 []', () => {
  const n = makeNode();
  assert.deepEqual(Mutate.pinnedEntries(n), []);
  n.pinned = [];
  assert.deepEqual(Mutate.pinnedEntries(n), []);
});

/* ---------- 折叠 ---------- */

test('foldKey 拼接毫秒', () => {
  assert.equal(Mutate.foldKey(100, 200), '100|200');
});

test('removeFold 精确匹配删除', () => {
  const n = makeNode();
  Mutate.addFold(n, 100, 200);
  Mutate.addFold(n, 300, 400);
  assert.equal(Mutate.removeFold(n, 100, 200), true);
  assert.deepEqual(n.folds, [{ from: 300, to: 400 }]);
  assert.equal(Mutate.removeFold(n, 100, 200), false);
});

test('addFold 拒绝倒序区间', () => {
  const n = makeNode();
  assert.equal(Mutate.addFold(n, 200, 100), null);
  assert.equal(Mutate.addFold(n, 'x', 100), null);
});

test('buildFoldCover 计算索引区间', () => {
  const n = makeNode();
  for (let i = 0; i < 5; i++) {
    Mutate.addEntry(n, { id: 'e' + i, text: '', createdAt: 1000 * (i + 1) });
  }
  Mutate.addFold(n, 2000, 4000);   // 覆盖 idx 1-3

  const cover = Mutate.buildFoldCover(n, 0);
  assert.ok(cover.has(1) && cover.has(2) && cover.has(3));
  assert.ok(!cover.has(0) && !cover.has(4));
  assert.equal(cover.get(2).a, 1);
  assert.equal(cover.get(2).b, 3);
});

test('buildFoldCover start 参数跳过前面的折叠', () => {
  const n = makeNode();
  for (let i = 0; i < 5; i++) {
    Mutate.addEntry(n, { id: 'e' + i, text: '', createdAt: 1000 * (i + 1) });
  }
  Mutate.addFold(n, 1000, 2000);   // 覆盖 idx 0-1
  const cover = Mutate.buildFoldCover(n, 2);   // 从 idx 2 开始渲染
  assert.ok(!cover.has(0));
  assert.ok(!cover.has(1));
});

test('buildFoldCover 无折叠时返回空 Map', () => {
  const n = makeNode();
  const cover = Mutate.buildFoldCover(n, 0);
  assert.equal(cover.size, 0);
});

// 追加到 mutate.test.js
test('insertSorted：最老的时间戳插到最前', () => {
  const n = makeNode();
  Mutate.addEntry(n, { id: 'b', text: 'B', createdAt: 2000 });
  Mutate.insertSorted(n, { id: 'a', text: 'A', createdAt: 500 });
  assert.deepEqual(n.entries.map(e => e.id), ['a', 'b']);
});

test('insertSorted：毫秒全部占用时顺延到空位', () => {
  const n = makeNode();
  Mutate.addEntry(n, { id: 'a', text: 'A', createdAt: 1000 });
  Mutate.addEntry(n, { id: 'b', text: 'B', createdAt: 1001 });
  Mutate.insertSorted(n, { id: 'c', text: 'C', createdAt: 1000 });
  assert.equal(n.entries[2].id, 'c');
  assert.equal(n.entries[2].createdAt, 1002);
});

test('addFold：区间相等也算重叠 → 被丢弃', () => {
  const n = makeNode();
  Mutate.addFold(n, 100, 200);
  Mutate.addFold(n, 100, 200);
  assert.equal(n.folds.length, 1);
});

test('addFold：紧邻但不重叠的两段都保留', () => {
  const n = makeNode();
  Mutate.addFold(n, 100, 200);
  Mutate.addFold(n, 201, 300);
  assert.equal(n.folds.length, 2);
});

test('buildFoldCover：折叠区间端点不在 entries 里 → 忽略', () => {
  const n = makeNode();
  Mutate.addEntry(n, { id: 'e', text: '', createdAt: 1000 });
  Mutate.addFold(n, 500, 9999);   // 端点不匹配任何 entry
  const cover = Mutate.buildFoldCover(n, 0);
  assert.equal(cover.size, 0);
});