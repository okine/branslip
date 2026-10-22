// tests/tree-utils.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../store.js';
import {
  walk, isDesc, subtreeIds, pathOf, pathTitles, pOf,
  findByPath, pathExists, stats,
} from '../tree-utils.js';

/* ---------- 场景搭建 ---------- */

const mk = (id, title, children = [], entries = []) => ({
  id, title, _name: title, _dir: null,
  children, entries, pinned: [], folds: [],
});

function setup() {
  const A = mk('A', '工作', [
    mk('A1', '项目', [ mk('A1a', '会议') ]),
    mk('A2', '周报'),
  ]);
  const B = mk('B', '生活');
  Store.root.children = [A, B];
  Store.root.entries = [];
  Store.rebuildIndex();
  return { A, B };
}

/* ---------- walk ---------- */

test('walk 遍历所有后代（不含自身）', () => {
  setup();
  const ids = [];
  walk(Store.root, n => ids.push(n.id));
  assert.deepEqual(ids.sort(), ['A', 'A1', 'A1a', 'A2', 'B']);
});

test('walk 遇自环不无限递归（只访问一次）', () => {
  const n = mk('X', 'X');
  n.children = [n];                  // 自环
  const visited = [];
  walk(n, x => visited.push(x.id));

  // 关键性质：能终止；且每个节点最多被 fn 处理一次
  assert.deepEqual(visited, ['X']);

  // 更强的说法：visited 里没有重复 —— 无论图里有多少环
  assert.equal(new Set(visited).size, visited.length);
});

test('walk 遇互环（A↔B）不无限递归', () => {
  const A = mk('A', 'A');
  const B = mk('B', 'B');
  A.children = [B];
  B.children = [A];

  const visited = [];
  walk(A, x => visited.push(x.id));   // 不应挂

  // 每个节点最多被 fn 处理一次；A 通过 B.children 被访问到，所以是 2 个
  assert.deepEqual(visited, ['B', 'A']);
  assert.equal(new Set(visited).size, visited.length, '每个节点只访问一次');
});

/* ---------- isDesc ---------- */

test('isDesc 判断后代关系', () => {
  setup();
  assert.equal(isDesc(Store.node('A'), Store.node('A1a')), true);
  assert.equal(isDesc(Store.node('A1'), Store.node('A1a')), true);
  assert.equal(isDesc(Store.node('A'), Store.node('B')), false);
});

test('isDesc 不把自身当作后代', () => {
  setup();
  assert.equal(isDesc(Store.node('A'), Store.node('A')), false);
});

/* ---------- subtreeIds ---------- */

test('subtreeIds 含自身与所有后代', () => {
  setup();
  assert.deepEqual(subtreeIds(Store.node('A')).sort(), ['A', 'A1', 'A1a', 'A2']);
  assert.deepEqual(subtreeIds(Store.node('A1a')), ['A1a']);
});

/* ---------- pathOf / pOf ---------- */

test('pathOf 从根到节点的完整路径', () => {
  setup();
  const p = pathOf(Store.node('A1a')).map(n => n.id);
  assert.deepEqual(p, ['A', 'A1', 'A1a']);
});

test('pOf 用 \\u0001 连接标题', () => {
  setup();
  assert.equal(pOf(Store.node('A1a')), '工作\u0001项目\u0001会议');
});

test('pathTitles 支持自定义分隔符', () => {
  setup();
  assert.equal(pathTitles(Store.node('A1a')), '工作 / 项目 / 会议');
  assert.equal(pathTitles(Store.node('A1a'), '/'), '工作/项目/会议');
});



/* ---------- findByPath ---------- */

test('findByPath 用 \\u0001 路径还原节点', () => {
  setup();
  const n = findByPath('工作\u0001项目\u0001会议');
  assert.equal(n.id, 'A1a');
});

test('findByPath 找不到返回 null', () => {
  setup();
  assert.equal(findByPath('不存在'), null);
  assert.equal(findByPath('工作\u0001不存在'), null);
  assert.equal(findByPath(''), null);
});

/* ---------- pathExists ---------- */

test('pathExists 对存在的路径返回 true', () => {
  setup();
  assert.equal(pathExists('工作\u0001项目'), true);
  assert.equal(pathExists('工作\u0001项目\u0001会议'), true);
});

test('pathExists 对不存在的路径返回 false', () => {
  setup();
  assert.equal(pathExists('不存在'), false);
});

/* ---------- stats ---------- */

test('stats 统计话题与记录总数', () => {
  setup();
  // 给 A1 塞两条记录
  Store.node('A1').entries.push(
    { id: 'e1', text: 'x', createdAt: 1 },
    { id: 'e2', text: 'y', createdAt: 2 },
  );
  const s = stats();
  assert.deepEqual(s, { t: 5, e: 2 });
});