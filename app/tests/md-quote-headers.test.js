// tests/md-quote-headers.test.js
/* md.js —— 回复头 / 关联头的识别与剥离。
 *
 * 三件套的不变量：
 *   isReplyMessage(t)   → stripQuoteHeader(t) 不含头，且不含全文（说明确实剥了）
 *   isRelatedMessage(t) → stripQuoteHeader(t) 不含头
 *   两者互斥（一条消息不会同时是回复和关联）
 *
 * 这条契约坏了的后果：回复消息变成普通气泡（气泡靠左/靠右错乱），
 * 或者关联头被当成正文显示出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  isReplyMessage, isRelatedMessage, stripQuoteHeader, parseRelevanceHeader,
} = await import('../md.js');

/* ---------- isReplyMessage ---------- */

test('isReplyMessage：标准多行引用 + [[...]]', () => {
  const t = '> 引用原文\n> [[~2026-09-17_09-00-00-000#^abc]]\n\n回复';
  assert.equal(isReplyMessage(t), true);
});

test('isReplyMessage：三行引用也算（多行预览）', () => {
  const t = '> 引用第一行\n> 引用第二行\n> [[~t#^abc]]\n\n回复';
  assert.equal(isReplyMessage(t), true);
});

test('isReplyMessage：只有一行 > 引用没有 [[...]] → false', () => {
  assert.equal(isReplyMessage('> 引用\n\n内容'), false);
});

test('isReplyMessage：普通文本 → false', () => {
  assert.equal(isReplyMessage('普通内容'), false);
});

test('isReplyMessage：空 / null / undefined → false', () => {
  assert.equal(isReplyMessage(''), false);
  assert.equal(isReplyMessage(null), false);
  assert.equal(isReplyMessage(undefined), false);
});

test('isReplyMessage：只有 [[...]] 没有 > 引用头 → false', () => {
  assert.equal(isReplyMessage('[[~t#^abc]]'), false);
});

test('isReplyMessage：> 后紧跟 [[...]] 没有空格也算', () => {
  const t = '> 预览\n>[[~t#^abc]]\n\n回复';
  assert.equal(isReplyMessage(t), true);
});

/* ---------- isRelatedMessage ---------- */

test('isRelatedMessage：标准关联头', () => {
  const t = '> 被关联原文\n∝ 关键字 [[~t#^bid]]\n\n正文';
  assert.equal(isRelatedMessage(t), true);
});

test('isRelatedMessage：∝ 后有多个空格也算', () => {
  const t = '> 预览\n∝    关键字 [[~t#^bid]]\n\n正文';
  assert.equal(isRelatedMessage(t), true);
});

test('isRelatedMessage：缺少 ∝ 头 → false', () => {
  const t = '> 预览\n[[~t#^bid]]\n\n正文';
  assert.equal(isRelatedMessage(t), false);
});

test('isRelatedMessage：第一行不是 > → false', () => {
  const t = '正文\n∝ 关键字 [[~t#^bid]]';
  assert.equal(isRelatedMessage(t), false);
});

test('isRelatedMessage：空 / null → false', () => {
  assert.equal(isRelatedMessage(''), false);
  assert.equal(isRelatedMessage(null), false);
});

/* ---------- 互斥性 ---------- */

test('★ 回复消息不是关联消息（互斥）', () => {
  const t = '> 引用\n> [[~t#^abc]]\n\n回复';
  assert.equal(isReplyMessage(t), true);
  assert.equal(isRelatedMessage(t), false);
});

test('★ 关联消息不是回复消息（互斥）', () => {
  const t = '> 预览\n∝ kw [[~t#^abc]]\n\n正文';
  assert.equal(isRelatedMessage(t), true);
  assert.equal(isReplyMessage(t), false);
});

/* ---------- stripQuoteHeader ---------- */

test('stripQuoteHeader：回复头剥掉', () => {
  const t = '> 引用\n> [[~t#^abc]]\n\n回复内容';
  assert.equal(stripQuoteHeader(t), '回复内容');
});

test('stripQuoteHeader：关联头剥掉', () => {
  const t = '> 预览\n∝ kw [[~t#^abc]]\n\n正文';
  assert.equal(stripQuoteHeader(t), '正文');
});

test('stripQuoteHeader：正文保留内部换行', () => {
  const t = '> 引用\n> [[~t#^abc]]\n\n第一行\n第二行\n第三行';
  assert.equal(stripQuoteHeader(t), '第一行\n第二行\n第三行');
});

test('stripQuoteHeader：没有头 → 原样返回', () => {
  const t = '普通内容';
  assert.equal(stripQuoteHeader(t), '普通内容');
});

test('stripQuoteHeader：空 / null → 空串', () => {
  assert.equal(stripQuoteHeader(''), '');
  assert.equal(stripQuoteHeader(null), '');
});

test('stripQuoteHeader：只有头没正文 → 原样返回（不匹配正则）', () => {
  /* 头后面缺 \n+ 正文，正则要求必须有 */
  const t = '> 引用\n> [[~t#^abc]]';
  assert.equal(stripQuoteHeader(t), t,
    '没有正文的"头"不该被剥掉 —— 那可能是条残缺的记录');
});

test('stripQuoteHeader：正文前导空行被吃掉', () => {
  const t = '> 引用\n> [[~t#^abc]]\n\n\n\n\n正文';
  assert.equal(stripQuoteHeader(t), '正文');
});

/* ---------- 对偶性（核心不变量） ---------- */

test('★ 识别为回复 → strip 之后不含 [[...]]，也不含头部 >', () => {
  const t = '> 引用原文\n> [[~t#^abc]]\n\n我的回复';
  assert.equal(isReplyMessage(t), true);

  const body = stripQuoteHeader(t);
  assert.equal(body, '我的回复');
  assert.ok(!body.startsWith('>'), '剥出的正文不该以 > 开头');
  assert.ok(!/\[\[/.test(body), '剥出的正文不该含引用标记');
});

test('★ 识别为关联 → strip 之后不含 ∝，也不含头部 >', () => {
  const t = '> 被关联原文\n∝ 关键字 [[~t#^abc]]\n\n正文';
  assert.equal(isRelatedMessage(t), true);

  const body = stripQuoteHeader(t);
  assert.equal(body, '正文');
  assert.ok(!body.startsWith('>'));
  assert.ok(!/∝/.test(body));
  assert.ok(!/\[\[/.test(body));
});

test('parseRelevanceHeader：取出标题 / 预览 / 引用目标', () => {
  const t = '> 被关联原文\n∝ 同一本书 [[~2026-09-17_09-00-00-000#^abc]]\n\n正文';
  assert.deepEqual(parseRelevanceHeader(t), {
    preview: '被关联原文',
    label: '同一本书',
    topicRef: '~2026-09-17_09-00-00-000',
    blockId: 'abc',
  });
  assert.equal(parseRelevanceHeader('普通内容'), null);
});

test('★ 对普通文本：isReply/isRelated 都 false 且 strip 原样', () => {
  const t = '完全普通的一段话，没有头';
  assert.equal(isReplyMessage(t), false);
  assert.equal(isRelatedMessage(t), false);
  assert.equal(stripQuoteHeader(t), t);
});

/* ---------- 边界：CRLF ---------- */

test('isReplyMessage / strip：CRLF 换行', () => {
  const t = '> 引用\r\n> [[~t#^abc]]\r\n\r\n回复';
  assert.equal(isReplyMessage(t), true);
  assert.equal(stripQuoteHeader(t), '回复');
});