// tests/md-preprocess.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMD } from '../md.js';

/* ---------- 内部引用（新格式） ---------- */

test('renderMD 新引用：带别名时不查 Store', () => {
  const h = renderMD('看这里 [[~2026-09-17_09-00-00-000#^abcd|说明]] 结束');
  assert.match(h, /class="md-ref"/);
  assert.match(h, /data-topic-id="2026-09-17_09-00-00-000"/);
  assert.match(h, /data-block="abcd"/);
  assert.match(h, /→ 说明/);
});

test('renderMD 旧引用：路径取最后一段当显示名', () => {
  const h = renderMD('[[工作\u001f项目#^abcd]]');
  assert.match(h, /class="md-ref"/);
  assert.match(h, /data-path="工作\u001f项目"/);
  assert.match(h, /data-block="abcd"/);
  assert.match(h, /→ 项目/);
});

test('renderMD 旧引用：斜杠路径', () => {
  const h = renderMD('[[工作/项目/会议#^abcd|会议记录]]');
  assert.match(h, /data-path="工作\/项目\/会议"/);
  assert.match(h, /→ 会议记录/);
});

test('renderMD 时间引用 [[path @ stamp]] 已不再支持（有意移除）', () => {
  const h = renderMD('[[工作 @ 2026-09-17 09:00:00]]');
  assert.ok(!/class="md-ref"/.test(h), '旧时间引用不应再渲染成链接');
  assert.match(h, /\[\[工作 @ 2026-09-17 09:00:00\]\]/);   // 原样保留
});

test('renderMD 引用别名里的 HTML 被转义', () => {
  const h = renderMD('[[~x#^y|<img src=x onerror=alert(1)>]]');
  assert.ok(!/<img/.test(h), '别名里的 <img> 必须被转义');
  assert.match(h, /&lt;img/);
});

/* ---------- # 标签 ---------- */

test('renderMD #标签：不吞前一个字符', () => {
  const h = renderMD('前缀 #待补完 后缀');
  assert.match(h, /data-tag="待补完"/);
  assert.match(h, />#待补完</);
});

test('renderMD #标签：括号后也识别', () => {
  const h = renderMD('（#重要）');
  assert.match(h, /data-tag="重要"/);
});

test('renderMD #标签：中文/字母/数字/下划线/短横', () => {
  const h = renderMD('#中文 #abc #xyz123 #a_b #x-y');
  assert.match(h, /data-tag="中文"/);
  assert.match(h, /data-tag="abc"/);
  assert.match(h, /data-tag="xyz123"/);
  assert.match(h, /data-tag="a_b"/);
  assert.match(h, /data-tag="x-y"/);
});

test('renderMD 代码块里的 # 不转标签', () => {
  const h = renderMD('```\n#不是标签\n```');
  assert.ok(!/data-tag/.test(h), '代码块里不该生成标签');
});

/* ---------- LaTeX ---------- */

test('renderMD \\[ \\] 归一化成 display', () => {
  const h = renderMD('\\[a^2+b^2=c^2\\]');
  assert.match(h, /katex-display/);
});

test('renderMD \\( \\) 归一化成 inline', () => {
  const h = renderMD('行内 \\(x^2\\) 结束');
  assert.match(h, /<span class="katex"/);
});

test('renderMD $$...$$ display', () => {
  const h = renderMD('$$\\int_0^1 x\\,dx$$');
  assert.match(h, /katex-display/);
});

test('renderMD 公式里的反斜杠不被 marked 吃掉', () => {
  const h = renderMD('$$\\frac{1}{2}$$');
  // 如果反斜杠被吃掉，KaTeX 会渲染不出分数
  assert.match(h, /katex/);
  assert.ok(!/\\\\frac/.test(h), '不该出现双反斜杠');
});

/* ---------- :::think ---------- */

test('renderMD :::think 折叠块', () => {
  const h = renderMD(':::think\n思考内容\n:::\n\n正文');
  assert.match(h, /<details class="md-think">/);
  assert.match(h, /💭 思考过程/);
  assert.match(h, /思考内容/);
  assert.match(h, /正文/);
});

test('renderMD :::think 内容里含 ::: 不提前闭合', () => {
  const h = renderMD(':::think\n先\n\\:::\n后\n:::');
  // 应该只有一个 <details>
  assert.equal((h.match(/<details/g) || []).length, 1);
});

/* ---------- 哨兵防御 ---------- */

test('renderMD：源文本里含私有区哨兵不炸', () => {
  const h = renderMD('正常 \uE000\uE000 文本');
  assert.ok(!h.includes('\uE000'), '哨兵必须被剥掉');
});

// 追加到 md-preprocess.test.js
test('renderMD 新引用：tid / block 里的特殊字符被转义', () => {
  const h = renderMD('[[~x"y#^b"c]]');
  // 引号不该出现在属性之外
  assert.ok(!/data-topic-id="x"/.test(h) || /data-topic-id="x&quot;y"/.test(h));
  // 只做粗断言
  assert.ok(!/<script/.test(h));
});

test('renderMD 时间引用不再支持：不生成链接，就是纯文本', () => {
  const h = renderMD('[[工作 @ 2026-09-17 09:00:00" onmouseover="x]]');
  assert.ok(!/class="md-ref"/.test(h), '不该生成 md-ref 链接');
  assert.ok(!/<a\s/.test(h), '不该生成任何 <a> 标签');
  // 原样保留（不会被删）
  assert.match(h, /\[\[工作 @ 2026-09-17 09:00:00/);
});

test('renderMD #tag：任何非字字符后都能识别', () => {
  const h = renderMD('（#已识别） 但 】#未识别');
  assert.match(h, /data-tag="已识别"/);
  assert.match(h, /data-tag="未识别"/);   // ← 现在能识别了
});

test('renderMD #tag：右括号 / 引号后也能识别', () => {
  assert.match(renderMD(')#待补完'),        /data-tag="待补完"/);
  assert.match(renderMD('「#重要」'),        /data-tag="重要"/);
  assert.match(renderMD('"#foo"'),          /data-tag="foo"/);
});

test('renderMD #tag：字/\\/# 前不识别', () => {
  assert.ok(!/data-tag/.test(renderMD('a#b')));
  assert.ok(!/data-tag/.test(renderMD('\\#b')));
  assert.ok(!/data-tag/.test(renderMD('##b')));
});

test('renderMD 行内公式：前面是数字也识别', () => {
  const h = renderMD('1$x^2$');
  assert.match(h, /katex/);
  assert.ok(!/katex-display/.test(h), '行内公式不该是 display 模式');
});