// tests/tree-ops.test.js
/* tree-ops.js —— 话题的写操作（新增 / 重命名 / 移动 / 删除）。
 *
 * 这些操作的共同结构是「同步改内存 + enqueue 里改磁盘」。磁盘那半跑在
 * writer 的串行队列里，测试里我们让它失败或原地挂起，只断言内存那一半：
 * 树结构、parentIndex、以及不变量守卫。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/* 必须在 import tree-ops 之前 —— 它间接 import image.js，
   而 image.js 顶层就会 new IntersectionObserver */
import { rootEl } from './_browser-stubs.js';

/* 补上 #toastRoot（deleteNode 的守卫分支会 toast），其余走桩的默认登记表 */
globalThis.document.querySelector = sel => rootEl(sel);

const { Store } = await import('../store.js');
const { markFsReady } = await import('../writer.js');
const {
  addNode, renameNode, moveNode, deleteNode,
} = await import('../tree-ops.js');

/* ---------- 场景搭建 ---------- */

const mk = (id, title, children = [], entries = []) => ({
  id, title, _name: title, _dir: null,
  children, entries, pinned: [], folds: [],
});

function setup() {
  const A1a = mk('A1a', '会议');
  const A1  = mk('A1', '项目', [A1a]);
  const A   = mk('A', '工作', [A1, mk('A2', '周报')]);
  const B   = mk('B', '生活');
  Store.root.children = [A, B];
  Store.root.entries  = [];
  Store.root.pinned   = [];
  Store.root.folds    = [];
  Store.rebuildIndex();

  Store.collapsed.clear();
  Store.ui.selectedId = null;

  /* 磁盘那半一律挂起（fs.ready=false → enqueue 排队等 markFsReady）。
     这样被测函数只留下内存副作用，且不会往控制台吐错。 */
  Store.fs.ready = false;
  Store.fs.pending = 0;
  Store.fs.hasError = false;
  Store.fs.chain = Promise.resolve();
  Store.setDir(null);

  return { A, A1, A1a, B };
}

beforeEach(setup);

/* ============================================================
 * addNode
 * ============================================================ */

test('addNode：挂到父话题下，返回新节点', () => {
  const { A } = setup();
  const n = addNode('A', '新话题');

  assert.ok(n, '要返回新节点');
  assert.equal(n.title, '新话题');
  assert.equal(A.children.length, 3);
  assert.equal(A.children[2], n);
  assert.equal(n._pending, true);              // 磁盘没跑完 → 仍是 pending
  assert.ok(Store.node(n.id), '新节点要进索引');
  assert.equal(Store.parent(n.id), A);
});

test('addNode：parentId 不存在 → 返回 null 且不动树', () => {
  const { B } = setup();
  assert.equal(addNode('不存在', 'x'), null);
  assert.equal(Store.root.children.length, 2);
  assert.equal(B.children.length, 0);
});

test('addNode：挂到根下时把新节点追加到末尾', () => {
  setup();
  const n = addNode('__root__', '第三个根话题');
  assert.equal(Store.root.children.length, 3);
  assert.equal(Store.root.children[2], n);
});

/* 折叠键 = pOf() = 标题路径用 \u0001 连接。
   注意：pOf 从根话题算起 —— 根话题自己是 '工作'，
   它的孩子是 '工作\u0001项目'，孙子是 '工作\u0001项目\u0001会议'。
   （渲染时最外层 branchHTML(c, 0, '') 传空 path，那是另一套算法，
     但祖先链上的节点在折叠/展开时用的都是这里的 pOf 语义。） */
const keyOfA1  = '工作\u0001项目';
const keyOfA1a = '工作\u0001项目\u0001会议';

test('addNode：往有内容的话题里加子话题会展开它（清掉折叠态）', () => {
  const { A1 } = setup();
  Store.collapsed.add(keyOfA1);

  addNode('A1', '子话题');
  assert.equal(Store.collapsed.has(keyOfA1), false);
});

test('addNode：折在父话题上的键也被清掉（pOf 语义）', () => {
  const { A } = setup();
  Store.collapsed.add('工作');                    // pOf(A) —— 根层的 key
  addNode('A', 'x');
  assert.equal(Store.collapsed.has('工作'), false);
});

test('addNode：加到根下不清任何折叠态', () => {
  setup();
  Store.collapsed.add('工作');
  addNode('__root__', 'x');
  assert.equal(Store.collapsed.has('工作'), true);
});

/* ============================================================
 * renameNode
 * ============================================================ */

test('renameNode：乐观改标题（磁盘那半挂起也不回滚）', () => {
  const { B } = setup();
  renameNode(B, '日常');
  assert.equal(B.title, '日常');
});

test('renameNode：清掉自身与整棵子树的折叠键', () => {
  const { A } = setup();
  Store.collapsed.add('工作');            // A 自己（根层 key）
  Store.collapsed.add(keyOfA1a);          // 后代 A1a
  Store.collapsed.add('生活');            // 无关节点

  renameNode(A, '搬砖');

  assert.equal(Store.collapsed.has('工作'), false);
  assert.equal(Store.collapsed.has(keyOfA1a), false,
    '子树的折叠键也用的是旧标题，必须一起清');
  assert.equal(Store.collapsed.has('生活'), true, '不能误伤别的节点');
});

test('renameNode：节点不在索引里 → 什么都不做', () => {
  setup();
  const orphan = mk('ZZ', '幽灵');
  assert.doesNotThrow(() => renameNode(orphan, '新名'));
  assert.equal(orphan.title, '幽灵', '找不到父节点时不该改内存');
});

/* ============================================================
 * moveNode
 * ============================================================ */

test('moveNode：pos=inside 挂到目标末尾', () => {
  const { A, B } = setup();
  moveNode('B', 'A1', 'inside');

  assert.equal(A.children.indexOf(B), -1, '要从原父摘掉');
  const A1 = Store.node('A1');
  assert.equal(A1.children[A1.children.length - 1], B);
  assert.equal(Store.parent('B').id, 'A1');
});

test('moveNode：pos=before / after 插到兄弟旁边', () => {
  const { A, B } = setup();
  moveNode('B', 'A2', 'before');
  assert.deepEqual(A.children.map(c => c.id), ['A1', 'B', 'A2']);

  moveNode('B', 'A1', 'after');
  assert.deepEqual(A.children.map(c => c.id), ['A1', 'B', 'A2']);
});

test('moveNode：inside 会展开新父话题', () => {
  const { B } = setup();
  Store.collapsed.add('工作');
  moveNode('B', 'A', 'inside');
  assert.equal(Store.collapsed.has('工作'), false);
});

test('moveNode：不能移到自己身上', () => {
  const { A } = setup();
  moveNode('A', 'A', 'inside');
  assert.equal(Store.parent('A').id, '__root__', '位置不该变');
});

test('moveNode：不能移进自己的后代（否则子树成环）', () => {
  const { A } = setup();
  moveNode('A', 'A1a', 'inside');       // A1a 是 A 的孙子
  assert.equal(Store.parent('A').id, '__root__');
  assert.equal(Store.node('A').children[0].id, 'A1');
});

test('moveNode：目标不存在 / 节点不存在 → 静默返回', () => {
  const { A } = setup();
  assert.doesNotThrow(() => moveNode('A', '不存在', 'inside'));
  assert.doesNotThrow(() => moveNode('不存在', 'A', 'inside'));
  assert.equal(A.children.length, 2);
});

test('moveNode：parentIndex 与 nodeIndex 都要跟上', () => {
  setup();
  moveNode('A1a', 'B', 'inside');
  assert.equal(Store.parent('A1a').id, 'B');
  assert.equal(Store.node('A1a').title, '会议');
  assert.equal(Store.node('A1').children.length, 0, '原父那里要摘干净');
});

/* ============================================================
 * deleteNode
 * ============================================================ */

test('deleteNode：未连接文件夹 → false，不动内存', async () => {
  const { A } = setup();
  Store.fs.ready = false;

  const ok = await deleteNode('A');
  assert.equal(ok, false);
  assert.equal(Store.parent('A').id, '__root__', '守卫失败时不能先摘节点');
});

test('deleteNode：节点不存在 → false', async () => {
  setup();
  Store.fs.ready = true;
  assert.equal(await deleteNode('不存在'), false);
});

test('deleteNode：磁盘失败 → 内存回滚到原位，返回 false', async () => {
  const { A } = setup();
  Store.fs.ready = true;
  /* 回收站取不到 → getTrashDir 抛错 → 走 restoreMem 分支 */
  Store.setDir({ name: 'fake' });

  const ok = await deleteNode('A');

  assert.equal(ok, false);
  assert.equal(Store.root.children.length, 2, '节点要放回树里');
  assert.equal(Store.root.children[0], A, '而且要回到原来的下标');
  assert.equal(Store.parent('A').id, '__root__', '索引也要重建回去');
  assert.equal(Store.fs.hasError, true);

  Store.setDir(null);
  Store.fs.hasError = false;
});
