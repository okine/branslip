// tests/utils.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { esc, uid, badgeColor, badgeHTML, PALETTE } from '../utils.js';

/* ---------- esc ---------- */

test('esc 转义 & < > " \'', () => {
  assert.equal(esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.equal(esc("it's"), 'it&#39;s');
  assert.equal(esc('a & b'), 'a &amp; b');
});

test('esc 不改变正常文本', () => {
  assert.equal(esc('普通中文 123'), '普通中文 123');
});

test('esc 对非字符串做 String() 转换', () => {
  assert.equal(esc(123), '123');
  assert.equal(esc(null), 'null');
});

/* ---------- uid ---------- */

test('uid 每次返回不同值', () => {
  const set = new Set();
  for (let i = 0; i < 200; i++) set.add(uid());
  assert.equal(set.size, 200);
});

test('uid 返回非空字符串', () => {
  const id = uid();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
});

/* ---------- badgeColor ---------- */

test('badgeColor 是确定性的（同 id 同色）', () => {
  assert.equal(badgeColor('abc'), badgeColor('abc'));
});

test('badgeColor 总返回调色板中的颜色', () => {
  for (const s of ['a', 'topic-1', '话题', '', 'x'.repeat(100)]) {
    assert.ok(PALETTE.includes(badgeColor(s)), `badgeColor(${s}) 越界`);
  }
});

test('badgeColor 不同 id 大概率不同色（哈希分散）', () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(badgeColor('id-' + i));
  // 20 个 id 打到 8 色，至少应看到 3 种以上（避免哈希塌缩）
  assert.ok(seen.size >= 3, '哈希函数似乎塌缩了');
});

/* ---------- badgeHTML ---------- */

test('badgeHTML 取标题首字符作为徽章', () => {
  const h = badgeHTML({ id: 'x', title: '工作' });
  assert.match(h, /<span class="badge /);
  assert.match(h, />工</);
});

test('badgeHTML 标题为空时用 ·', () => {
  const h = badgeHTML({ id: 'x', title: '' });
  assert.match(h, />·</);
});

test('badgeHTML 转义标题中的特殊字符（防 XSS）', () => {
  const h = badgeHTML({ id: 'x', title: '<script>' });
  assert.ok(!h.includes('<script>'), '标题里的 < 必须被转义');
  assert.match(h, /&lt;/);
});

test('badgeHTML 支持附加 class', () => {
  const h = badgeHTML({ id: 'x', title: 'A' }, 'extra');
  assert.match(h, /class="badge extra"/);
});