// tests/meta-row.test.js
/* meta-row.js —— 引用计数领域。
 *
 * 守两条核心不变量：
 *   ① 增量路径（add / diff / remove）必须和全量路径（buildGlobalMetaCounts）
 *      给出相同结果 —— 否则用户改一条消息，脚标数字会跟真实引用数打架。
 *   ② 一条 entry 的文本里同一 bid 引用 N 次，只算 1（去重按 entry 而非按次）。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { Store } = await import('../store.js');
const {
  scanEntryRefs,
  buildGlobalMetaCounts,
  addGlobalMetaFor,
  diffGlobalMetaFor,
  removeGlobalMetaFor,
} = await import('../meta-row.js');

const mk = (id, title, entries = []) => ({
  id, title, _name: title, _dir: null,
  children: [], entries, pinned: [], folds: [],
});

const entry = (id, text) => ({ id, text, createdAt: 1, edited: false, editedAt: null });

function setup(entries = []) {
    const A = mk('A', '工作', entries);
    const B = mk('B', '生活');
    Store.root.children = [A, B];
    Store.root.entries = [];
    Store.rebuildIndex();
  
    /* 清干净再重置标志位 */
    Store.replyCounts.clear();
    Store.mirrorCounts.clear();
    Store.relevanceCounts.clear();
    Store.resetMetaBuilt();
    return { A, B };
  }

/* ============================================================
 * scanEntryRefs —— 纯函数
 * ============================================================ */

test('scanEntryRefs：普通引用归入 reply', () => {
  const r = scanEntryRefs('看这个 [[~2026-09-17_09-00-00-000#^abc123]]');
  assert.deepEqual(r.reply, ['abc123']);
  assert.deepEqual(r.mirror, []);
  assert.deepEqual(r.relevance, []);
});

test('scanEntryRefs：! 前缀归入 mirror', () => {
  const r = scanEntryRefs('![[~tid#^xyz]]');
  assert.deepEqual(r.mirror, ['xyz']);
  assert.deepEqual(r.reply, []);
});

test('scanEntryRefs：∝ 头归入 relevance，正文里的 [[...]] 归 reply', () => {
  const text = [
    '> 被关联的原文',
    '∝ 关键字 [[~tid#^relBlock]]',
    '',
    '正文里还有 [[~tid#^replyBlock]]',
  ].join('\n');

  const r = scanEntryRefs(text);
  assert.deepEqual(r.relevance, ['relBlock']);
  assert.deepEqual(r.reply, ['replyBlock']);
  assert.deepEqual(r.mirror, []);
});

test('scanEntryRefs：同一条 entry 里重复引用同一 bid → 只算一次', () => {
  const r = scanEntryRefs(
    '[[~tid#^dup]] 加 [[~tid#^dup]] 再加 [[~tid#^dup]]'
  );
  assert.deepEqual(r.reply, ['dup']);
});

test('scanEntryRefs：reply 与 mirror 引用的同一个 bid 各自独立计', () => {
  const r = scanEntryRefs('[[~t#^b]] 和 ![[~t#^b]]');
  assert.deepEqual(r.reply, ['b']);
  assert.deepEqual(r.mirror, ['b']);
});

test('scanEntryRefs：带别名的引用', () => {
  const r = scanEntryRefs('[[~tid#^bid|别名]]');
  assert.deepEqual(r.reply, ['bid']);
});

test('scanEntryRefs：旧路径引用也能被识别', () => {
  const r = scanEntryRefs('[[工作\u001f项目#^bid]]');
  assert.deepEqual(r.reply, ['bid']);
});

test('scanEntryRefs：空文本 / null → 三个空数组', () => {
  assert.deepEqual(scanEntryRefs(''),   { reply: [], relevance: [], mirror: [] });
  assert.deepEqual(scanEntryRefs(null), { reply: [], relevance: [], mirror: [] });
});

test('scanEntryRefs：不含任何引用 → 三个空数组', () => {
  const r = scanEntryRefs('普通文本，没有引用');
  assert.deepEqual(r, { reply: [], relevance: [], mirror: [] });
});

/* ============================================================
 * buildGlobalMetaCounts —— 全量
 * ============================================================ */

test('buildGlobalMetaCounts：扫全库，按 bid 归类', () => {
  setup([
    entry('e1', '普通 [[~t#^bid1]]'),
    entry('e2', '镜像 ![[~t#^bid2]]'),
    entry('e3', '> 预览\n∝ kw [[~t#^bid3]]\n\n正文'),
  ]);
  const g = buildGlobalMetaCounts();

  assert.equal(g.reply.get('bid1').size, 1);
  assert.equal(g.reply.get('bid1').has('e1'), true);

  assert.equal(g.mirror.get('bid2').size, 1);
  assert.equal(g.mirror.get('bid2').has('e2'), true);

  assert.equal(g.relevance.get('bid3').size, 1);
  assert.equal(g.relevance.get('bid3').has('e3'), true);
});

test('buildGlobalMetaCounts：多条 entry 引用同一 bid → set 里有多个 id', () => {
  setup([
    entry('e1', '[[~t#^shared]]'),
    entry('e2', '[[~t#^shared]]'),
    entry('e3', '![[~t#^shared]]'),
  ]);
  const g = buildGlobalMetaCounts();

  assert.equal(g.reply.get('shared').size, 2);
  assert.deepEqual([...g.reply.get('shared')].sort(), ['e1', 'e2']);
  assert.equal(g.mirror.get('shared').size, 1);
});

test('buildGlobalMetaCounts：跨话题累计', () => {
  const A = mk('A', 'A', [entry('e1', '[[~t#^x]]')]);
  const B = mk('B', 'B', [entry('e2', '[[~t#^x]]')]);
  Store.root.children = [A, B];
  Store.root.entries = [];
  Store.rebuildIndex();
  Store.resetMetaBuilt();

  const g = buildGlobalMetaCounts();
  assert.equal(g.reply.get('x').size, 2);
});

test('buildGlobalMetaCounts：空树 → 三个空 Map', () => {
  setup();
  const g = buildGlobalMetaCounts();
  assert.equal(g.reply.size, 0);
  assert.equal(g.mirror.size, 0);
  assert.equal(g.relevance.size, 0);
});

/* ============================================================
 * addGlobalMetaFor —— 增量追加
 * ============================================================ */

test('★ addGlobalMetaFor：增量追加，等价于重新全量', () => {
  const { A } = setup([entry('e1', '[[~t#^x]]')]);
  const g = buildGlobalMetaCounts();
  Store.setMetaCounts(g.reply, g.mirror, g.relevance);

  /* 追加一条新 entry，走增量路径 */
  const e2 = entry('e2', '[[~t#^x]] 和 ![[~t#^y]]');
  A.entries.push(e2);
  Store.indexEntry(e2, A);
  addGlobalMetaFor(e2);

  /* 与重新全量对比 —— 这是核心不变量 */
  const full = buildGlobalMetaCounts();
  assert.equal(Store.replyCounts.get('x').size, full.reply.get('x').size);
  assert.deepEqual(
    [...Store.replyCounts.get('x')].sort(),
    [...full.reply.get('x')].sort()
  );
  assert.equal(Store.mirrorCounts.get('y').size, full.mirror.get('y').size);
});

test('addGlobalMetaFor：Store 未构建（isMetaBuilt=false）→ no-op', () => {
  setup();
  Store.resetMetaBuilt();          // 确认未构建
  const e = entry('e1', '[[~t#^x]]');
  addGlobalMetaFor(e);

  assert.equal(Store.isMetaBuilt(), false);
  /* 无异常、也没在未构建的 Store 上乱写 */
  assert.equal(Store.replyCounts.size, 0);
});

/* ============================================================
 * diffGlobalMetaFor —— 编辑差量
 * ============================================================ */

test('★ diffGlobalMetaFor：旧引用被撤掉 → set 空 → key 删除', () => {
  setup();
  Store.setMetaCounts(
    new Map([['A', new Set(['e1'])]]),
    new Map(),
    new Map()
  );

  const e = entry('e1', 'new [[~t#^B]]');
  diffGlobalMetaFor(e, 'old [[~t#^A]]', 'new [[~t#^B]]');

  assert.equal(Store.replyCounts.has('A'), false,
    'A 的 set 空了以后 key 要被删掉，否则后面 count=0 的徽章还会渲染');
  assert.equal(Store.replyCounts.get('B').has('e1'), true);
});

test('diffGlobalMetaFor：新引用是旧引用的超集 → 旧的保留，新的加上', () => {
  setup();
  Store.setMetaCounts(
    new Map([['A', new Set(['e1'])]]),
    new Map(),
    new Map()
  );

  const e = entry('e1', '[[~t#^A]] 和 [[~t#^B]]');
  diffGlobalMetaFor(e, '[[~t#^A]]', '[[~t#^A]] 和 [[~t#^B]]');

  assert.equal(Store.replyCounts.get('A').has('e1'), true, 'A 的引用还在');
  assert.equal(Store.replyCounts.get('B').has('e1'), true, 'B 是新加的');
});

test('diffGlobalMetaFor：编辑后引用完全不变 → 两边都保留', () => {
  setup();
  Store.setMetaCounts(
    new Map([['A', new Set(['e1'])]]),
    new Map(),
    new Map()
  );

  const e = entry('e1', '[[~t#^A]] 文字改了但引用没变');
  diffGlobalMetaFor(e, '[[~t#^A]] 原文', '[[~t#^A]] 文字改了但引用没变');

  assert.equal(Store.replyCounts.get('A').has('e1'), true);
  assert.equal(Store.replyCounts.get('A').size, 1);
});

test('diffGlobalMetaFor：跨类迁移 —— reply → mirror', () => {
  setup();
  Store.setMetaCounts(
    new Map([['X', new Set(['e1'])]]),
    new Map(),
    new Map()
  );

  const e = entry('e1', '![[~t#^X]]');
  diffGlobalMetaFor(e, '[[~t#^X]]', '![[~t#^X]]');

  assert.equal(Store.replyCounts.has('X'), false,
    'reply 里的 e1 应当被移除，空 set 被删');
  assert.equal(Store.mirrorCounts.get('X').has('e1'), true,
    '同时进入 mirror');
});

test('diffGlobalMetaFor：多条并存 —— 只移除本 entry，别人不受影响', () => {
  setup();
  Store.setMetaCounts(
    new Map([['A', new Set(['e1', 'e2', 'e3'])]]),
    new Map(),
    new Map()
  );

  const e = entry('e1', 'no more ref');
  diffGlobalMetaFor(e, '[[~t#^A]]', 'no more ref');

  assert.deepEqual([...Store.replyCounts.get('A')].sort(), ['e2', 'e3']);
});

test('diffGlobalMetaFor：Store 未构建 → no-op', () => {
  setup();
  Store.resetMetaBuilt();
  const e = entry('e1', '[[~t#^A]]');
  assert.doesNotThrow(() =>
    diffGlobalMetaFor(e, '[[~t#^A]]', '[[~t#^A]] 变了'));
});

/* ============================================================
 * removeGlobalMetaFor —— 删除
 * ============================================================ */

test('★ removeGlobalMetaFor：全部撤掉；set 空 → key 删除', () => {
  setup();
  Store.setMetaCounts(
    new Map([['X', new Set(['e1'])]]),
    new Map([['Y', new Set(['e1'])]]),
    new Map([['Z', new Set(['e1'])]]),
  );

  const e = entry('e1', '[[~t#^X]] 和 ![[~t#^Y]]\n> p\n∝ k [[~t#^Z]]\n\nbody');
  removeGlobalMetaFor(e);

  assert.equal(Store.replyCounts.has('X'), false);
  assert.equal(Store.mirrorCounts.has('Y'), false);
  assert.equal(Store.relevanceCounts.has('Z'), false);
});

test('removeGlobalMetaFor：别的 entry 的引用不动', () => {
  setup();
  Store.setMetaCounts(
    new Map([['A', new Set(['e1', 'e2'])]]),
    new Map(),
    new Map()
  );

  const e = entry('e1', '[[~t#^A]]');
  removeGlobalMetaFor(e);

  assert.deepEqual([...Store.replyCounts.get('A')], ['e2']);
});

/* ============================================================
 * 三条增量路径 vs 全量 —— 综合对照
 * ============================================================ */

test('★ 增删改混合：增量维护后与全量重建完全一致', () => {
  const { A } = setup([entry('e1', '[[~t#^x]]')]);
  let g = buildGlobalMetaCounts();
  Store.setMetaCounts(g.reply, g.mirror, g.relevance);

  /* 追加 e2 */
  const e2 = entry('e2', '![[~t#^x]]');
  A.entries.push(e2);
  Store.indexEntry(e2, A);
  addGlobalMetaFor(e2);

  /* 编辑 e1：x → y */
  diffGlobalMetaFor(e1Of(A), '[[~t#^x]]', '[[~t#^y]]');
  A.entries[0].text = '[[~t#^y]]';

  /* 删除 e2 */
  A.entries = A.entries.filter(e => e.id !== 'e2');
  Store.rebuildIndex();
  removeGlobalMetaFor(e2);

  /* 重新全量 */
  const full = buildGlobalMetaCounts();

  /* 逐 key 比较（set 大小 + 内容） */
  for (const bag of ['reply', 'mirror', 'relevance']) {
    const live = Store[bag + 'Counts'];
    const keys = new Set([...live.keys(), ...full[bag].keys()]);
    for (const k of keys) {
      const a = live.get(k) || new Set();
      const b = full[bag].get(k) || new Set();
      assert.deepEqual([...a].sort(), [...b].sort(),
        bag + '[' + k + '] 增量与全量不一致');
    }
  }
});

function e1Of(A) { return A.entries.find(e => e.id === 'e1'); }