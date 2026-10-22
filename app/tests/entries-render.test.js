// tests/entries-render.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { Store } = await import('../store.js');
const {
  entryHTML, entryInnerHTML,
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
