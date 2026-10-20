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

test('entryHTML：tools 里四类按钮齐全', () => {
  reset();
  const h = entryHTML({ id: 'a', text: 'x', createdAt: 1000 }, 0, { id: 'n', title: 'N' });
  for (const a of ['edit', 'pin', 'moveEntry', 'del']) {
    assert.match(h, new RegExp(`data-eact="${a}"`));
  }
});
