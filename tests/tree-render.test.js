// tests/tree-render.test.js
/* tree-render.js —— 左栏渲染 / 搜索。
 *
 * 测纯渲染：给 Store 一份树，断言出来的 HTML。
 * 需要一个 document 桩（tree-render.js 顶层就 $('#treeScroll')），
 * 其中 #treeScroll / #scopeBtn 要返回真实存在的假元素。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fakeEl } from './_browser-stubs.js';

/* renderTree() 会往 #treeScroll.innerHTML 写，syncScopeBtn() 要读 #scopeBtn。
   所以这两个选择器必须给出真实存在的假元素（其余返回 null 即可）。
   treeBox 是模块级 const，只取一次 —— 要断言它就得盯住同一个对象。 */
const treeScrollEl = fakeEl();
const scopeBtnEl = fakeEl();

globalThis.document = {
  querySelector: sel => (
    sel === '#treeScroll' ? treeScrollEl :
    sel === '#scopeBtn'   ? scopeBtnEl   : null
  ),
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
  body: fakeEl(),
  documentElement: fakeEl(),
  addEventListener() {},
  removeEventListener() {},
};

/* 这条 import 必须在 document 桩之后：tree-render.js 顶层就 $('#treeScroll') */
const { Store } = await import('../store.js');
const {
  branchHTML, renderTree, renderSearch, syncScopeBtn,
} = await import('../tree-render.js');

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
  Store.rebuildIndex();

  Store.collapsed.clear();
  Store.ui.query        = '';
  Store.ui.searchScope  = 'topic';
  Store.ui.searchShown  = 100;
  Store.ui.selectedId   = null;
  Store.ui.renaming     = null;
  Store.ui.creatingParent = null;
  return { A, A1, A1a, B };
}

beforeEach(setup);

/* ---------- branchHTML ---------- */

test('branchHTML：一层节点带出 data-id / data-d 与标题', () => {
  const { A } = setup();
  const h = branchHTML(A, 0, '');
  assert.match(h, /data-branch="A"/);
  assert.match(h, /data-id="A"/);
  assert.match(h, /class="row-title">工作</);
  assert.match(h, /--d:0/);
});

test('branchHTML：未折叠时递归渲染子孙，折叠时不递归', () => {
  const { A } = setup();
  assert.match(branchHTML(A, 0, ''), /data-id="A1a"/);   // 未折叠 → 孙子也在

  Store.collapsed.add('工作');                            // pOf(A) === '工作'
  const h = branchHTML(A, 0, '');
  assert.doesNotMatch(h, /data-id="A1"/);
  assert.match(h, /class="branch collapsed"/);
});

test('branchHTML：collapsed 的 key 是标题路径，不是 id', () => {
  /* 这是 pOf 的语义 —— 曾经写成 id 会导致折叠点了没反应 */
  const { A } = setup();
  Store.collapsed.add('A');
  assert.match(branchHTML(A, 0, ''), /data-id="A1"/);    // 'A' 不是合法 key → 仍然展开
});

test('branchHTML：创建子话题时才插入 .creating 行', () => {
  const { A } = setup();
  assert.doesNotMatch(branchHTML(A, 0, ''), /creating/);

  Store.ui.creatingParent = 'A';
  const h = branchHTML(A, 0, '');
  assert.match(h, /class="node-row creating"/);          // 自己的子层多一行输入
  assert.match(h, /class="create-input"/);
});

test('branchHTML：创建中即使折叠也要摊开（否则看不到输入框）', () => {
  const { A } = setup();
  Store.collapsed.add('工作');
  Store.ui.creatingParent = 'A';
  const h = branchHTML(A, 0, '');
  assert.doesNotMatch(h, /collapsed/);
  assert.match(h, /class="create-input"/);
});

test('branchHTML：选中节点带 .selected', () => {
  const { B } = setup();
  Store.ui.selectedId = 'B';
  assert.match(branchHTML(B, 0, ''), /class="node-row selected"/);
});

test('branchHTML：重命名态渲染 input.rename，值已转义', () => {
  const { B } = setup();
  Store.ui.renaming = 'B';
  B.title = 'a"b';
  const h = branchHTML(B, 0, '');
  assert.match(h, /<input class="rename" value="a&quot;b">/);
});

test('branchHTML：_pending 的节点显示 … 计数位', () => {
  const { B } = setup();
  B._pending = true;
  assert.match(branchHTML(B, 0, ''), /正在创建/);
});

test('branchHTML：标题里的 HTML 被转义', () => {
  const { B } = setup();
  B.title = '<img src=x onerror=alert(1)>';
  const h = branchHTML(B, 0, '');
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img/);
});

/* ---------- renderTree ---------- */

test('renderTree：根层创建行只在 creatingParent=__root__ 时出现', () => {
  setup();
  renderTree();
  assert.doesNotMatch(treeScrollEl.innerHTML, /create-input/);

  Store.ui.creatingParent = '__root__';
  renderTree();
  assert.match(treeScrollEl.innerHTML, /class="node-row creating"/);
  assert.match(treeScrollEl.innerHTML, /create-input/);
});

test('renderTree：有搜索词时走搜索分支，不出树', () => {
  setup();
  Store.ui.query = '生活';
  renderTree();
  assert.match(treeScrollEl.innerHTML, /res-head/);
  assert.doesNotMatch(treeScrollEl.innerHTML, /class="branch/);
});

test('renderTree：stagger 只在整页首次渲染时出现一次', () => {
  /* firstTree 是模块级状态，不能重置 —— 只能断言"最多出现一次"这个不变量 */
  setup();
  renderTree();
  const first = treeScrollEl.innerHTML;
  renderTree();
  const second = treeScrollEl.innerHTML;

  assert.ok(!(first.includes('stagger') && second.includes('stagger')),
    'stagger 不能在连续两次渲染里都出现');
  assert.doesNotMatch(second, /stagger/);
});

/* ---------- renderSearch ---------- */

test('renderSearch：空查询给提示', () => {
  Store.ui.query = '';
  assert.match(renderSearch(), /输入关键词/);
});

test('renderSearch：命中话题标题', () => {
  Store.ui.query = '工作';
  Store.ui.searchScope = 'all';
  const h = renderSearch();
  assert.match(h, /话题 · 1/);
  assert.match(h, /data-goto="A"/);
});

test('renderSearch：命中记录正文，并按时间倒序', () => {
  const { A } = setup();
  A.entries = [
    { id: 'e1', text: '会议记录 Alpha', createdAt: 1000 },
    { id: 'e2', text: '会议记录 Beta',  createdAt: 2000 },
  ];
  Store.rebuildIndex();
  Store.ui.query = '会议';
  Store.ui.searchScope = 'all';

  const h = renderSearch();
  assert.match(h, /记录 · 2/);
  assert.ok(h.indexOf('data-goto-entry="e2"') < h.indexOf('data-goto-entry="e1"'),
    '新的记录要排在前面');
});

test('renderSearch：scope=topic 只搜当前话题的子树', () => {
  const { B } = setup();
  Store.ui.selectedId = 'B';
  Store.ui.searchScope = 'topic';
  Store.ui.query = '工作';
  /* B（生活）子树里没有「工作」→ 提示条 */
  assert.match(renderSearch(), /本话题下没有匹配/);
  assert.match(renderSearch(), /切换到全局搜索/);
});

test('renderSearch：scope=all 时不受 selectedId 限制', () => {
  const { B } = setup();
  Store.ui.selectedId = 'B';
  Store.ui.searchScope = 'all';
  Store.ui.query = '工作';
  assert.match(renderSearch(), /data-goto="A"/);
});

test('renderSearch：超过 searchShown 时给"显示更多"', () => {
  const { A } = setup();
  A.entries = Array.from({ length: 5 }, (_, i) => ({
    id: 'e' + i, text: '命中词 ' + i, createdAt: 1000 + i,
  }));
  Store.rebuildIndex();
  Store.ui.query = '命中词';
  Store.ui.searchScope = 'all';
  Store.ui.searchShown = 2;

  const h = renderSearch();
  assert.match(h, /显示更多 · 还有 3 条/);
});

test('renderSearch：完全没命中给空提示', () => {
  setup();
  Store.ui.query = '绝对不存在的词';
  Store.ui.searchScope = 'all';
  assert.match(renderSearch(), /没有找到与/);
});

test('renderSearch：命中片段被 <mark> 包住且做了转义', () => {
  const { A } = setup();
  A.entries = [{ id: 'e1', text: '看 <b>重点</b> 内容', createdAt: 1000 }];
  Store.rebuildIndex();
  Store.ui.query = '重点';
  Store.ui.searchScope = 'all';

  const h = renderSearch();
  assert.match(h, /<mark>重点<\/mark>/);
  assert.doesNotMatch(h, /<b>/);
});

/* ---------- syncScopeBtn ---------- */

test('syncScopeBtn：没选中话题 → 强制全局', () => {
  setup();
  Store.ui.searchScope = 'topic';
  Store.ui.selectedId = null;
  syncScopeBtn();
  assert.equal(Store.ui.searchScope, 'all');
  assert.equal(scopeBtnEl.textContent, '全局');
});

test('syncScopeBtn：选中话题时按 searchScope 显示', () => {
  setup();
  Store.ui.selectedId = 'A';

  Store.ui.searchScope = 'topic';
  syncScopeBtn();
  assert.equal(scopeBtnEl.textContent, '本话题');

  Store.ui.searchScope = 'all';
  syncScopeBtn();
  assert.equal(scopeBtnEl.textContent, '全局');
});
