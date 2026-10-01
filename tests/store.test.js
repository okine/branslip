// tests/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../store.js';

const mk = (id, title, children = [], entries = []) => ({
  id, title, _name: title, _dir: null,
  children, entries, pinned: [], folds: [],
});

test('rebuildIndex 建立节点/父子/记录索引', () => {
  Store.root.children = [
    mk('A', 'A', [mk('A1', 'A1')], [
      { id: 'e1', text: 'x', createdAt: 1 },
    ]),
  ];
  Store.rebuildIndex();

  assert.ok(Store.node('A'));
  assert.ok(Store.node('A1'));
  assert.equal(Store.parent('A1').id, 'A');
  assert.equal(Store.entry('e1').node.id, 'A');
  assert.equal(Store.entry('e1').e.id, 'e1');
});

test('node/parent/entry 对未知 id 返回 null', () => {
  Store.rebuildIndex();
  assert.equal(Store.node('不存在'), null);
  assert.equal(Store.parent('不存在'), null);
  assert.equal(Store.entry('不存在'), null);
});

test('node(null) 返回 null 而不是崩溃', () => {
  assert.equal(Store.node(null), null);
  assert.equal(Store.parent(undefined), null);
  assert.equal(Store.entry(''), null);
});

test('indexNode 增量插入', () => {
  Store.root.children = [];
  Store.rebuildIndex();
  const p = Store.root;
  const n = mk('N', 'N', [], [{ id: 'x', text: '', createdAt: 1 }]);
  Store.indexNode(n, p);
  assert.equal(Store.node('N'), n);
  assert.equal(Store.parent('N'), p);
  assert.ok(Store.entry('x'));
});

test('unindexNode 清理子节点与记录', () => {
  Store.root.children = [ mk('N', 'N', [], [{ id: 'x', text: '', createdAt: 1 }]) ];
  Store.rebuildIndex();
  const n = Store.node('N');
  Store.unindexNode(n);
  assert.equal(Store.node('N'), null);
  assert.equal(Store.entry('x'), null);
});

test('indexEntry / removeEntry 配对维护 entryIndex', () => {
  Store.root.children = [];
  Store.rebuildIndex();
  const n = mk('N', 'N');
  Store.indexNode(n, Store.root);

  const e = { id: 'z', text: '', createdAt: 1 };
  n.entries.push(e);
  Store.indexEntry(e, n);
  assert.ok(Store.entry('z'));

  Store.removeEntry(n, 'z');
  assert.equal(Store.entry('z'), null);
});

test('rebuildIndex 是幂等的', () => {
  Store.root.children = [ mk('A', 'A', [mk('A1', 'A1')]) ];
  Store.rebuildIndex();
  const before = [...Store.nodes()].map(n => n.id).sort();
  Store.rebuildIndex();
  const after = [...Store.nodes()].map(n => n.id).sort();
  assert.deepEqual(after, before);
});

test('setDir 更新 dir 句柄', () => {
  const fake = { name: 'fake' };
  Store.setDir(fake);
  assert.equal(Store.dir, fake);
  Store.setDir(null);          // 还原
});