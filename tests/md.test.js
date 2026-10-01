// tests/md.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseEntries, splitByImage, renderMD,
  isReplyMessage, topicRefId, normalizeTopicRefId, } from '../md.js';
import { stampForWrite, entryBlockId } from '../format.js';


/* ---------- parseEntries ---------- */

test('parseEntries 解析一条记录', () => {
  const md = [
    '# 工作 · 2026-09',
    '',
    '## 2026-09-17 09:00:00.000+08:00',
    '',
    '第一条',
  ].join('\n');

  const list = parseEntries(md);

  assert.equal(list.length, 1);
  assert.equal(list[0].text, '第一条');
  assert.equal(list[0].edited, false);
  assert.ok(list[0].createdAt > 0, 'createdAt 应该是正数毫秒');
});

test('parseEntries 解析多条 + 已编辑标记', () => {
  const md = [
    '## 2026-09-17 09:00:00.000+08:00',
    '',
    '一',
    '',
    '## 2026-09-18 10:00:00.000+08:00（已编辑 2026-09-18 11:00:00.000+08:00）',
    '',
    '二',
  ].join('\n');

  const list = parseEntries(md);

  assert.equal(list.length, 2);
  assert.equal(list[0].text, '一');
  assert.equal(list[1].text, '二');
  assert.equal(list[1].edited, true);
  assert.ok(list[1].editedAt, 'editedAt 应该被解析出来');
});

test('parseEntries 还原被转义的 #', () => {
  const md = [
    '## 2026-09-17 09:00:00.000+08:00',
    '',
    '\\# 这是普通文本，不是标题',
  ].join('\n');

  const list = parseEntries(md);

  assert.equal(list[0].text, '# 这是普通文本，不是标题');
});

test('parseEntries 空文本 → 返回空数组', () => {
  assert.deepEqual(parseEntries(''), []);
  assert.deepEqual(parseEntries('# 只有标题\n'), []);
});

/* ---------- splitByImage ---------- */

test('splitByImage 把文本和图片拆开', () => {
  const parts = splitByImage('看图 ![](attachments/a.png) 就懂');

  assert.equal(parts.length, 3);
  assert.equal(parts[0].t, '看图 ');
  assert.equal(parts[1].img, 'attachments/a.png');
  assert.equal(parts[2].t, ' 就懂');
});

test('splitByImage 没有图片时返回单段', () => {
  const parts = splitByImage('纯文本');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].t, '纯文本');
});

test('splitByImage 连续两张图', () => {
  const parts = splitByImage('![](a.png)![](b.png)');

  assert.equal(parts.length, 2);
  assert.equal(parts[0].img, 'a.png');
  assert.equal(parts[1].img, 'b.png');
});

/* ---------- renderMD ---------- */
/* 注意：这些测试避开了 [[~tid#^bid]] 引用，因为那条路径依赖 Store。 */

test('renderMD 粗体', () => {
  const h = renderMD('**粗**');
  assert.match(h, /<strong>粗<\/strong>/);
});

test('renderMD 行内代码', () => {
  const h = renderMD('这是 `code` 啊');
  assert.match(h, /<code class="md-code">code<\/code>/);
});

test('renderMD 代码块带语言标签', () => {
  const h = renderMD('```js\nconst a=1;\n```');
  assert.match(h, /md-pre-lang">js</);
  assert.match(h, /<code>const a=1;<\/code>/);
});

test('renderMD 会转义 HTML 特殊字符', () => {
  const h = renderMD('a < b & c');
  assert.match(h, /&lt;/);
  assert.match(h, /&amp;/);
});

test('renderMD #标签', () => {
  const h = renderMD('这有个 #待补完 的标记');
  assert.match(h, /class="md-tag" data-tag="待补完"/);
});

test('renderMD 裸链接', () => {
  const h = renderMD('看 https://example.com 一下');
  assert.match(h, /href="https:\/\/example.com"/);
});

test('renderMD 表格', () => {
  const h = renderMD([
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
  ].join('\n'));
  assert.match(h, /<table>/);
  assert.match(h, /<th>A<\/th>/);
  assert.match(h, /<td>1<\/td>/);
});

test('renderMD 标题', () => {
  const h = renderMD('### 三级标题');
  assert.match(h, /<h3[^>]*>三级标题<\/h3>/);
});

test('renderMD 原始 HTML 被转义（防 script 泄漏）', () => {
  const h = renderMD('<script>alert(1)</script>');
  assert.ok(!/<script/.test(h), 'HTML 里的 <script> 必须被转义');
  assert.match(h, /&lt;script&gt;/);
});


/* ---------- isReplyMessage ---------- */

test('isReplyMessage 识别标准回复格式', () => {
  const t = '> 引用原文\n> [[~2026-09-17_09-00-00-000#^abc123]]\n\n回复内容';
  assert.equal(isReplyMessage(t), true);
});

test('isReplyMessage 普通消息返回 false', () => {
  assert.equal(isReplyMessage('普通内容'), false);
  assert.equal(isReplyMessage(''), false);
  assert.equal(isReplyMessage(null), false);
});

test('isReplyMessage 只有引用没跳转链接 → false', () => {
  const t = '> 引用\n\n内容';
  assert.equal(isReplyMessage(t), false);
});

/* ---------- topicRefId ---------- */

test('topicRefId 转换时间戳格式', () => {
  const node = { topicId: '2026-09-17 09:00:00.000+08:00' };
  assert.equal(topicRefId(node), '2026-09-17_09-00-00-000');
});

test('topicRefId 缺 topicId 返回 null', () => {
  assert.equal(topicRefId({}), null);
  assert.equal(topicRefId(null), null);
});

test('topicRefId 非法格式返回 null', () => {
  assert.equal(topicRefId({ topicId: '不是时间' }), null);
});

test('topicRefId 补全缺失的毫秒/秒', () => {
  const node = { topicId: '2026-09-17 09:00' };
  assert.equal(topicRefId(node), '2026-09-17_09-00-00-000');
});

/* ---------- normalizeTopicRefId ---------- */

test('normalizeTopicRefId 已是规范格式原样返回', () => {
  assert.equal(
    normalizeTopicRefId('2026-09-17_09-00-00-000'),
    '2026-09-17_09-00-00-000',
  );
});

test('normalizeTopicRefId 转换可读时间戳', () => {
  assert.equal(
    normalizeTopicRefId('2026-09-17 09:00:00'),
    '2026-09-17_09-00-00-000',
  );
});

test('normalizeTopicRefId 空值返回空值', () => {
  assert.equal(normalizeTopicRefId(''), '');
  assert.equal(normalizeTopicRefId(null), null);
});

/* ---------- renderMD 更多 ---------- */

test('renderMD 引用块被识别为 blockquote', () => {
  const h = renderMD('> 这是引用');
  assert.match(h, /<blockquote class="md-quote/);
});

test('renderMD 长引用块带 collapsible 类', () => {
  const long = Array.from({ length: 10 }, (_, i) => '> 第 ' + i + ' 行').join('\n');
  const h = renderMD(long);
  assert.match(h, /md-quote collapsible/);
});

test('renderMD 短引用块不带 collapsible 类', () => {
  const h = renderMD('> 短');
  assert.ok(!/collapsible/.test(h), '短引用不该折叠');
});

test('renderMD 代码块里的反引号不渲染成行内代码', () => {
  const h = renderMD('```\n`not inline`\n```');
  // 代码块整体被替换为占位符 → 最终展开成 md-pre
  assert.match(h, /md-pre/);
  assert.ok(!h.includes('<code class="md-code">not inline</code>'));
});

test('renderMD 只对 http/mailto 链接放行', () => {
  const h = renderMD('[x](javascript:alert(1))');
  assert.ok(!h.includes('javascript:'), 'javascript: 协议必须被过滤');
});

test('renderMD autolink 里的引号不能逃逸出属性', () => {
  const h = renderMD('<https://x.com/"onmouseover="alert(1)">');

  // 关键：整个输出里不该出现任何形式的 onmouseover= 属性
  assert.ok(!/\sonmouseover\s*=/i.test(h), 'onmouseover 必须被转义');
  // 更强的断言：属性值里不该有裸露的 "
  const href = h.match(/href="([^"]*)"/);
  assert.ok(href, 'href 属性应能被正常提取');
  assert.ok(!href[1].includes('"'), 'href 值里不该出现未转义的引号');
});

test('renderMD autolink 里的 < > 不能逃逸', () => {
  const h = renderMD('<https://x.com/"><script>alert(1)</script>');
  // 全局兜底已经把 < 转义了 —— 这里固化这个不变量
  assert.ok(!/<script/i.test(h));
  assert.match(h, /&lt;script/);
});


test('写盘头 stampForWrite → parseEntries → entryBlockId 稳定', () => {
  const e = {
    id: 'x',
    text: '跨时区引用',
    createdAt: Date.parse('2025-01-01T02:00:00.000Z'),
    _rawStamp: '2025-01-01 10:00:00.000+08:00',
    edited: false,
  };
  const header = stampForWrite(e);
  const md = [
    '# 话题 · 2025-01',
    '',
    '## ' + header,
    '',
    e.text,
  ].join('\n');

  const [p] = parseEntries(md);
  assert.ok(p);
  assert.equal(entryBlockId(p), '2025-01-01_10-00-00-000');
  assert.equal(entryBlockId(p), entryBlockId(e));
});