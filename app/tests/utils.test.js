// tests/utils.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { esc, uid, badgeColor, badgeHTML, PALETTE, countLabel, filterTopicsByTitle } from '../utils.js';

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

/* ---------- countLabel ---------- */

test('countLabel：超过 999 只显示 999+', () => {
  assert.equal(countLabel(0), '0');
  assert.equal(countLabel(1), '1');
  assert.equal(countLabel(999), '999');
  assert.equal(countLabel(1000), '999+');
  assert.equal(countLabel(123456), '999+');
  assert.equal(countLabel(null), '0');
});
/* ---------- filterTopicsByTitle（导入话题选择器的搜索） ---------- */

const TOPICS = [
  { id: 0, title: '深度学习入门' },
  { id: 1, title: 'React Hooks 笔记' },
  { id: 2, title: '実习面试回顾' },
  { id: 3, title: '' },
];

test('filterTopicsByTitle：空查询返回全部（且不共享数组）', () => {
  const out = filterTopicsByTitle(TOPICS, '');
  assert.equal(out.length, 4);
  assert.notEqual(out, TOPICS);
  assert.equal(filterTopicsByTitle(TOPICS, '   ').length, 4);
});

test('filterTopicsByTitle：中文子串匹配', () => {
  assert.deepEqual(filterTopicsByTitle(TOPICS, '学习').map(x => x.id), [0]);
  assert.deepEqual(filterTopicsByTitle(TOPICS, '面试').map(x => x.id), [2]);
});

test('filterTopicsByTitle：英文大小写不敏感', () => {
  assert.deepEqual(filterTopicsByTitle(TOPICS, 'react').map(x => x.id), [1]);
  assert.deepEqual(filterTopicsByTitle(TOPICS, 'HOOKS').map(x => x.id), [1]);
  assert.deepEqual(filterTopicsByTitle(TOPICS, 'React hooks').map(x => x.id), [1]);
});

test('filterTopicsByTitle：无匹配 / 异常输入', () => {
  assert.equal(filterTopicsByTitle(TOPICS, 'zzz').length, 0);
  assert.equal(filterTopicsByTitle(null, 'x').length, 0);
  assert.deepEqual(filterTopicsByTitle([{ id: 9 }], 'x'), []);
});
