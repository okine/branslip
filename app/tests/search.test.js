// tests/search.test.js
/* search.js —— 查询解析 / 高亮纯函数。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseQuery, highlightText } = await import('../search.js');

test('parseQuery：普通词 / 短语 / 排除 / 标签', () => {
  const q = parseQuery('工作 "项目复盘" -草稿 #待补完');
  assert.deepEqual(q.terms, ['工作']);
  assert.deepEqual(q.phrases, ['项目复盘']);
  assert.deepEqual(q.exclude, ['草稿']);
  assert.deepEqual(q.tags, ['待补完']);
});

test('parseQuery：过滤器', () => {
  const q = parseQuery('is:pinned has:image topic:工作 after:2026-01-01 before:2026-12-31');
  assert.equal(q.pinned, true);
  assert.equal(q.hasImage, true);
  assert.equal(q.topic, '工作');
  assert.ok(q.after != null);
  assert.ok(q.before != null && q.before > q.after);
});

test('parseQuery：负短语', () => {
  const q = parseQuery('-"旧版本" 发布');
  assert.deepEqual(q.exclude, ['旧版本']);
  assert.deepEqual(q.terms, ['发布']);
});

test('highlightText：转义 HTML 并只包住命中段', () => {
  const q = parseQuery('重点');
  const h = highlightText('看 <b>重点</b> 内容', q);
  assert.match(h, /&lt;b&gt;<mark>重点<\/mark>&lt;\/b&gt;/);
  assert.doesNotMatch(h, /<b>/);
});

test('highlightText：没有查询词时只转义', () => {
  const h = highlightText('<img src=x>', parseQuery(''));
  assert.equal(h, '&lt;img src=x&gt;');
});

test('parseQuery：空查询与非法日期不产生过滤器', () => {
  const q = parseQuery('   after:not-a-date   ');
  assert.deepEqual(q.terms, []);
  assert.equal(q.after, null);
});

test('highlightText：多个词分别标记，正则特殊字符安全', () => {
  const q = parseQuery('a+b "完整"');
  const h = highlightText('a+b 和 完整 内容', q);
  assert.match(h, /<mark>a\+b<\/mark>/);
  assert.match(h, /<mark>完整<\/mark>/);
});
