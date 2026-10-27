// tests/entries-render.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { Store } = await import('../store.js');
const {
  entryHTML, entryInnerHTML, altRowHTML, buildAltGroups,
  setDialogueEnabled,
} = await import('../entries-render.js');
const { resetMeta } = await import('../meta-row.js');

function reset() {
  Store.ui.editingEntry = null;
  Store.ui.merged = null;
  resetMeta();
}

test('entryInnerHTML：普通文本 → 转义后进 .etext', () => {
  reset();
  const e = { id: 'a', text: '<script>', createdAt: 1000 };
  const h = entryInnerHTML(e, { id: 'n', title: 'N' });
  assert.ok(!h.includes('<script>'));
  assert.match(h, /&lt;script&gt;/);
});

test('entryInnerHTML：编辑态用 textarea', () => {
  reset();
  Store.ui.editingEntry = 'a';
  const h = entryInnerHTML({ id: 'a', text: '原', createdAt: 1000 });
  assert.match(h, /class="entry editing"/);
  assert.match(h, /<textarea/);
});

test('entryInnerHTML：关联头拆成徽章，正文只保留 body', () => {
  reset();
  const e = {
    id: 'r1',
    text: '> 被关联的原文\n∝ 关联标签 [[~t1#^b1]]\n\n正文 **重点**',
    createdAt: 1000,
  };
  const n = { id: 'n', title: 'N', entries: [e], pinned: [], children: [] };
  const h = entryInnerHTML(e, n);
  assert.match(h, /class="relevance-head"/);
  assert.match(h, /data-relev-block="b1"/);
  assert.match(h, /关联标签/);
  assert.doesNotMatch(h, /∝/);
  assert.match(h, /被关联的原文/);   // quote preview
  assert.match(h, /正文/);
});


test('entryHTML：对谈模式下回复消息走 reply-entry', () => {
  reset();
  setDialogueEnabled(true);
  const e = {
    id: 'a', text: '> 引用\n> [[~x#^y]]\n\n回复',
    createdAt: 1000,
  };
  const h = entryHTML(e, 0, { id: 'n', title: 'N' });
  assert.match(h, /class="entry-row reply-entry"/);
});

test('entryHTML：关闭对谈模式后 reply 不再特殊', () => {
  reset();
  setDialogueEnabled(false);
  const e = { id: 'a', text: '> 引用\n> [[~x#^y]]\n\n回复', createdAt: 1000 };
  const h = entryHTML(e, 0, { id: 'n', title: 'N' });
  assert.ok(!h.includes('reply-entry'));
  setDialogueEnabled(true);  // 还原
});

test('entryHTML：行内只保留编辑按钮，其余动作收进右键菜单', () => {
  reset();
  const h = entryHTML({ id: 'a', text: 'x', createdAt: 1000 }, 0, { id: 'n', title: 'N' });
  assert.match(h, /data-eact="edit"/);
  for (const a of ['pin', 'moveEntry', 'del']) {
    assert.ok(!h.includes(`data-eact="${a}"`), `${a} 不该再出现在行内`);
  }
});

/* ============================================================
 * 变体行：一行只显示一版，其余藏在翻页里
 * ============================================================ */

test('altRowHTML：N 个版本共用一行，只有当前版本可见', () => {
  reset();
  const node = { id: 'n1', title: '话题' };
  const a = { id: 'v1', text: '主回答', createdAt: 1000, _tzOffset: 480, _writeStamp: '2026-01-01 00:00:01.000+08:00' };
  const b = { id: 'v2', text: '另一版', createdAt: 2000, _tzOffset: 480, _writeStamp: '2026-01-01 00:00:02.000+08:00' };
  const c = { id: 'v3', text: '第三版', createdAt: 3000, _tzOffset: 480, _writeStamp: '2026-01-01 00:00:03.000+08:00' };

  const h = altRowHTML(a, [b, c], 0, node, 0);
  assert.match(h, /class="entry-row alt-row"/);
  assert.equal((h.match(/data-alt-body="/g) || []).length, 3, '三个版本各有一个 body');
  assert.equal((h.match(/data-alt-body="\d" data-alt-eid="[^"]+" data-alt-time="[^"]+"/g) || []).length, 3);
  assert.equal((h.match(/ hidden>/g) || []).length, 2, '只有第一个可见');
  assert.match(h, /data-eid="v1"/, '行上的 eid 是当前版本');
  assert.match(h, /<b>1<\/b> \/ 3/, '页码 1 / 3');
  assert.match(h, /主回答/);
});

test('altRowHTML：active 指定第几版就显示第几版', () => {
  reset();
  const node = { id: 'n1', title: '话题' };
  const a = { id: 'v1', text: 'A', createdAt: 1000, _tzOffset: 480, _writeStamp: '2026-01-01 00:00:01.000+08:00' };
  const b = { id: 'v2', text: 'B', createdAt: 2000, _tzOffset: 480, _writeStamp: '2026-01-01 00:00:02.000+08:00' };
  const h = altRowHTML(a, [b], 0, node, 1);
  assert.match(h, /data-eid="v2"/);
  assert.match(h, /<b>2<\/b> \/ 2/);
  /* 第一个 body 带 hidden，第二个不带 */
  const first = h.slice(h.indexOf('data-alt-body="0"'), h.indexOf('data-alt-body="1"'));
  assert.match(first, / hidden>/);
});

/* ============================================================
 * buildAltGroups：锚点必须在窗口内，否则变体按普通行渲染
 * ============================================================ */

test('buildAltGroups：锚点在窗口内 → 变体归组', () => {
  const anchor = { id: 'a', text: '主回答', createdAt: 1,
    _writeStamp: '2026-01-01 00:00:01.000+08:00' };
  const variant = { id: 'v', text: '↻ [[~t#^2026-01-01_00-00-01-000]]\n\n另一版', createdAt: 2,
    _writeStamp: '2026-01-01 00:00:02.000+08:00' };
  const node = { entries: [anchor, variant] };
  const resolve = () => ({ e: anchor, node });

  const r = buildAltGroups(node, 0, 2, resolve);
  assert.deepEqual([...r.isAlt], ['v']);
  assert.equal(r.altOf.get('a').length, 1);
});

test('buildAltGroups：锚点在窗口外 → 不当变体（否则两条都不渲染）', () => {
  const anchor = { id: 'a', text: '主回答', createdAt: 1,
    _writeStamp: '2026-01-01 00:00:01.000+08:00' };
  const variant = { id: 'v', text: '↻ [[~t#^2026-01-01_00-00-01-000]]\n\n另一版', createdAt: 2,
    _writeStamp: '2026-01-01 00:00:02.000+08:00' };
  const node = { entries: [anchor, variant] };
  const resolve = () => ({ e: anchor, node });

  const r = buildAltGroups(node, 1, 2, resolve);   /* 只渲染变体这一行 */
  assert.equal(r.isAlt.size, 0, '不能标记为变体');
  assert.equal(r.altOf.size, 0);
});

test('buildAltGroups：node 索引缓存随 entries 变化失效', () => {
  const anchor = { id: 'a', text: '主回答', createdAt: 1,
    _writeStamp: '2026-01-01 00:00:01.000+08:00' };
  const v1 = { id: 'v1', text: '↻ [[~t#^2026-01-01_00-00-01-000]]\n\n版本1', createdAt: 2,
    _writeStamp: '2026-01-01 00:00:02.000+08:00' };
  const v2 = { id: 'v2', text: '↻ [[~t#^2026-01-01_00-00-01-000]]\n\n版本2', createdAt: 3,
    _writeStamp: '2026-01-01 00:00:03.000+08:00' };
  const node = { entries: [anchor, v1] };
  const resolve = () => ({ e: anchor, node });

  const r1 = buildAltGroups(node, 0, 2, resolve);
  assert.equal(r1.altOf.get('a').length, 1);

  node.entries.push(v2);                      /* entries 变化 → 缓存应失效 */
  const r2 = buildAltGroups(node, 0, 3, resolve);
  assert.equal(r2.altOf.get('a').length, 2, '新增变体后要能重新分组');
});

/* ---------- 主视角 ---------- */

test('entryHTML：owner 的消息右对齐并隐藏发送者前缀', () => {
  reset();
  const e = { id: 'e1', text: '**A**\n你好', createdAt: 1000,
    _writeStamp: '2026-01-01 00:00:01.000+08:00' };
  const h = entryHTML(e, 0, { id: 'n1', title: 'T', owner: 'A' }, null);
  assert.match(h, /pov-me/);
  assert.doesNotMatch(h, /\*\*A\*\*/);
  assert.match(h, /你好/);
});

test('entryHTML：其他人的消息左对齐，保留名字', () => {
  reset();
  const e = { id: 'e2', text: '**B**\n嗨', createdAt: 2000,
    _writeStamp: '2026-01-01 00:00:02.000+08:00' };
  const h = entryHTML(e, 0, { id: 'n1', title: 'T', owner: 'A' }, null);
  assert.match(h, /pov-other/);
  assert.match(h, /<strong>B<\/strong>/);
});

test('entryHTML：回复消息的发送者在引用头后，主视角也能识别', () => {
  reset();
  const e = { id: 'e3',
    text: '> 原文\n> [[~t#^b1]]\n\n**A**\n我的话',
    createdAt: 3000, _writeStamp: '2026-01-01 00:00:03.000+08:00' };
  const h = entryHTML(e, 0, { id: 'n1', title: 'T', owner: 'A' }, null);
  assert.match(h, /pov-me/);
  assert.match(h, /原文/);
  assert.match(h, /我的话/);
  assert.doesNotMatch(h, /\*\*A\*\*/);
});
