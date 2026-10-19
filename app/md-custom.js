// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE



'use strict';
/* ================= md-custom.js =================
 * 自定义 Markdown 语法的预处理器。
 *
 * 覆盖：
 *   ```code```          代码块
 *   `inline`            行内代码
 *   :::think …:::       思考块
 *   ![[~tid#^bid]]      镜像
 *   [[~tid#^bid|alias]] 新引用
 *   [[path#^bid|alias]] 旧路径引用
 *   #标签
 *   <http://…>          autolink
 *   \(…\) \[…\]         LaTeX 定界符
 *   $$…$$ $…$           KaTeX 公式
 *
 * 契约：
 *   preprocess(src, { renderMirror?, resolveTopicRef?, noEmbed? })
 *     → { text, stash }
 *   postprocess(html, stash) → html
 *
 * 业务依赖通过 opts 注入，本模块零业务耦合。
 */

import { esc } from './utils.js';
import katex from './vendor/katex/katex.mjs';

/* ---------- 哨兵 ---------- */

const REF_SENTINEL = '\uE000';
const REF_SENTINEL_RE = new RegExp(REF_SENTINEL, 'g');
const REF_PLACEHOLDER_RE = new RegExp(REF_SENTINEL + '(\\d+)' + REF_SENTINEL, 'g');

/* ---------- 公式 ---------- */

function renderMathHTML(body, displayMode) {
  try {
    return katex.renderToString(body, {
      throwOnError: false,
      displayMode: !!displayMode,
    });
  } catch (e) {
    console.error('[renderMath] 渲染失败', e);
    return '<span class="katex-error">' + esc(body) + '</span>';
  }
}

/* ---------- preprocess ---------- */

export function preprocess(src, opts) {
  opts = opts || {};
  const allowEmbed      = !opts.noEmbed;
  const renderMirror    = opts.renderMirror    || null;
  const resolveTopicRef = opts.resolveTopicRef || (() => null);

  const safeSrc = src.includes(REF_SENTINEL)
    ? src.replace(REF_SENTINEL_RE, '')
    : src;

  const stash = [];
  const put = h => {
    stash.push(h);
    return REF_SENTINEL + (stash.length - 1) + REF_SENTINEL;
  };

  let t = safeSrc;

  /* ── 代码块 ── */
  if (t.includes('```')) {
    t = t.replace(/```([^\n\r]*)\r?\n([\s\S]*?)```/g, (m, lang, code) => {
      const language = (lang || '').trim() || 'code';
      const body = code.replace(/\r?\n$/, '').replace(/\r\n?/g, '\n');
      return put(
        '<div class="md-pre-wrap">' +
          '<div class="md-pre-head">' +
            '<span class="md-pre-lang">' + esc(language) + '</span>' +
            '<button type="button" class="md-pre-copy">复制</button>' +
          '</div>' +
          '<pre class="md-pre"><code>' + esc(body) + '</code></pre>' +
        '</div>');
    });
  }

  /* ── 行内代码 ── */
  if (t.includes('`')) {
    t = t.replace(/`([^`\n]*)`/g, (m, code) =>
      put('<code class="md-code">' + esc(code) + '</code>'));
  }

  /* ── :::think ── */
  if (t.includes(':::think')) {
    t = t.replace(/^:::think\n([\s\S]*?)\n:::/gm, (m, inner) => {
      const body = inner.replace(/^\\:::/gm, ':::');
      return put(
        '<details class="md-think">' +
        '<summary>💭 思考过程</summary>' +
        '<div class="md-think-body">' + esc(body) + '</div>' +
        '</details>');
    });
  }

  /* ── blockquote 段落分隔 ── */
  if (t.includes('>')) {
    t = t.replace(/(^>.*(?:\n>.*)*)\n(?=[^>\n])/gm, '$1\n\n');
  }

  /* ── 镜像 ![[...]] —— 必须在普通引用之前 ── */
  if (allowEmbed && renderMirror && t.includes('![[')) {
    t = t.replace(
      /!\[\[~([A-Za-z0-9_\-]+)#\^([A-Za-z0-9_\-]+)\]\]/g,
      (m, tid, block) => put(renderMirror(tid, block))
    );
  }

  /* ── 引用 ── */
  if (t.includes('[[')) {
    /* 新引用 */
    t = t.replace(
      /\[\[~([A-Za-z0-9_\-]+)#\^([A-Za-z0-9_\-]+)(?:\|([^\[\]]*))?\]\]/g,
      (m, tid, block, alias) => {
        let display = (alias && alias.trim()) || null;
        if (!display) {
          const node = resolveTopicRef(tid);
          display = node ? node.title : '(话题)';
        }
        return put('<a class="md-ref" data-topic-id="' + tid +
                   '" data-block="' + block + '">→ ' + esc(display) + '</a>');
      });

    /* 旧路径引用 */
    t = t.replace(
      /\[\[(?!~)([^\[\]|#^]+?)#\^([A-Za-z0-9_\-]+)(?:\|([^\[\]]*))?\]\]/g,
      (m, path, block, alias) => {
        const p = path.trim();
        const last = p.split(/[\/\u001f]/).pop() || p;
        const display = (alias && alias.trim()) || last;
        return put('<a class="md-ref" data-path="' + esc(p) +
                   '" data-block="' + esc(block) + '">→ ' + esc(display) + '</a>');
      });
  }

  /* ── Telegram 风格内联链接：文字 (URL) ──
   锚文本允许空格，但不含换行、圆括号、方括号、竖线 ——
   换行会让一条消息横跨多行；括号是 URL 的包裹符号；方括号避开
   已有 markdown 链接 [text](url)；竖线是 Telegram 复制时常用的分隔符。
   非贪婪 +? 保证锚文本尽量短，遇到最靠近的 "(http..." 就停。 */
  if (t.includes('(http')) {
    t = t.replace(
      /([^\n()\[\]|]+?)\s+\((https?:\/\/[^\s)]+)\)/g,
      (m, text, url) =>
        put('<a class="md-link" href="' + esc(url) +
            '" target="_blank" rel="noopener">' + esc(text) + '</a>')
    );
  }
  /* ── #标签 ── */
  if (t.includes('#')) {
    t = t.replace(
      /(?<![A-Za-z0-9_\u4e00-\u9fa5#\\\/?&=.@:;])#([A-Za-z0-9_\u4e00-\u9fa5-]+)/g,
      (m, tag) => put('<a class="md-tag" data-tag="' + tag + '">#' + tag + '</a>')
    );
  }

  /* ── autolink ── */
  if (t.includes('<')) {
    t = t.replace(/<((?:https?|mailto):[^<>\s]+)>/g,
      (m, url) => put('<a class="md-link" href="' + esc(url) +
                      '" target="_blank" rel="noopener">' + esc(url) + '</a>'));
  }

  /* ── LaTeX 定界符规范化 ── */
  if (t.includes('\\[')) {
    t = t.replace(/\\\[([\s\S]+?)\\\]/g, (m, body) => '$$' + body + '$$');
  }
  if (t.includes('\\(')) {
    t = t.replace(/\\\(([\s\S]+?)\\\)/g, (m, body) => '$' + body + '$');
  }

  /* ── 块级公式 $$…$$ ── */
  if (t.includes('$$')) {
    const first = t.indexOf('$$');
    if (t.indexOf('$$', first + 2) >= 0) {
      t = t.replace(/\$\$([\s\S]+?)\$\$/g,
        (m, body) => put(renderMathHTML(body, true)));
    }
  }

  /* ── 行内公式 $…$ ── */
  if (t.includes('$')) {
    t = t.replace(/(^|[^\\$])\$(?!\s)([^\n$]+?)(?<!\s)\$/g,
      (m, pre, body) => pre + put(renderMathHTML(body, false)));
  }

  /* ── 兜底转义 < ── */
  if (t.includes('<')) {
    t = t.replace(/</g, '&lt;');
  }

  return { text: t, stash };
}

/* ---------- postprocess ---------- */

export function postprocess(html, stash) {
  let prev;
  for (let i = 0; i < 20; i++) {
    prev = html;
    html = html.replace(REF_PLACEHOLDER_RE, (m, idx) => stash[+idx] ?? '');
    if (html === prev) break;
  }
  return html;
}