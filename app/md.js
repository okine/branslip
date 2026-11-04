// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE



'use strict';
/* ================= md.js =================
 * Markdown 渲染与解析。标准语法交给 marked，自定义语法自己处理。
 *
 * 自定义语法（渲染前用占位符保护）：
 *   [[~tid#^bid|alias]]   新引用
 *   [[path#^bid|alias]]   旧引用
 *   [[path @ stamp]]      旧时间引用     已停止支持
 *   #标签
 *   ![[~tid#^bid]]        镜像
 *   :::think              llm思考块
 *
 * 代码块 / 行内代码 / 引用块 / 链接 / 原始 HTML：自定义 renderer，保留原有 CSS 类名。
 */

import { preprocess, postprocess } from './md-custom.js';
import { marked } from './vendor/marked.esm.js';
import { esc } from './utils.js';
import { parseStampToMs, 
  unescapeEntryBody,topicRefIdFromStamp,entryBlockId } from './format.js';
import { Store } from './store.js';
import { pathTitles, topicRefId, findTopicByRefId } from './tree-utils.js';
export { topicRefId, findTopicByRefId };


/* ---------- marked 配置 ---------- */

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    /* 原始 HTML 一律转义，防止 AI 回复里的 <script>/<div> 破坏渲染 */
    html({ text }) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    code({ text, lang }) {
      const l = (lang || '').trim() || 'code';
      const body = text.replace(/\r?\n$/, '').replace(/\r\n?/g, '\n');
      return '<div class="md-pre-wrap">' +
        '<div class="md-pre-head">' +
          '<span class="md-pre-lang">' + esc(l) + '</span>' +
          '<button type="button" class="md-pre-copy">复制</button>' +
        '</div>' +
        '<pre class="md-pre"><code>' + esc(body) + '</code></pre>' +
      '</div>';
    },
    codespan({ text }) {
      return '<code class="md-code">' + esc(text) + '</code>';
    },
    blockquote({ tokens }) {
      const inner = this.parser.parse(tokens);
      const plainLen = inner.replace(/<[^>]*>/g, '').length;
      const lines = (inner.match(/\n/g) || []).length + 1;
      const cls = (lines > 5 || plainLen > 200) ? ' collapsible' : '';
      return '<blockquote class="md-quote' + cls + '">' + inner + '</blockquote>';
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = /^(https?:|mailto:|#)/i.test(href) ? href : '#';
      return '<a class="md-link" href="' + esc(safe) + '"' +
        (title ? ' title="' + esc(title) + '"' : '') +
        ' target="_blank" rel="noopener">' + text + '</a>';
    },
  },
});
/* 解析"变体"头：`↻ [[~tid#^bid]]` —— 这一条是锚点那条的另一个版本。
   格式和回复头一致，只是把 `> 引用` 换成 `↻ 锚点`。 */
export function parseAltHeader(text) {
  if (!text) return null;
  const m = String(text).match(/^[ \t]*↻\s*\[\[([^\]]+)#\^([^\]]+)\]\](?:[^\n]*\n)?/);
  if (!m) return null;
  return { topicRef: m[1], blockId: m[2] };
}

/* 判断一条消息是否是"关联"：第一行是引用预览，第二行是 ∝ 头标签 */
export function isRelatedMessage(text) {
  return !!parseRelevanceHeader(text);
}

/* 解析关联头：返回 { preview, label, topicRef, blockId } 或 null。
   buildEntryText 生成的格式：
     > 被关联原文
     ∝ 关联标题 [[~tid#^bid]]
*/
export function parseRelevanceHeader(text) {
  if (!text) return null;
  const m = String(text).match(
    /^>[^\n]*\r?\n∝\s*([^\[]*?)\s*\[\[([^\]]+)#\^([^\]]+)\]\]/
  );
  if (!m) return null;
  const first = String(text).split(/\r?\n/)[0] || '';
  return {
    preview: first.replace(/^\s*>\s*/, '').trim(),
    label: m[1].trim(),
    topicRef: m[2],
    blockId: m[3],
  };
}

/* 全库已有“关联标题”去重列表，供建立关联时的输入候选使用 */
export function listRelevanceTitles() {
  const set = new Set();
  for (const node of Store.nodes()) {
    if (node.id === '__root__') continue;
    for (const e of node.entries) {
      const rel = parseRelevanceHeader(e.text);
      if (rel && rel.label) set.add(rel.label);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}
/* 社交导入（Telegram / QQ）在正文开头用 `**名字**` 标记发送者。
   返回 { name, body }；没有前缀返回 null。 */
export function parseSenderPrefix(text) {
  if (!text) return null;
  const s = String(text);
  /* 回复消息的引用头在最前面，发送者前缀在它后面（写盘时 header 是 prepend 的） */
  const rest = stripQuoteHeader(s);
  const head = s.slice(0, s.length - rest.length);
  const m = rest.match(/^\*\*((?:\\.|[^*\\])+)\*\*[ \t]*\r?\n?/);
  if (!m) return null;
  const name = m[1].replace(/\\([\\`*_[\]()])/g, '$1');
  return { name, body: head + rest.slice(m[0].length) };
}

/* 一个话题里出现过的发送者（按出现次数降序） */
export function listSenders(entries) {
  const map = new Map();
  for (const e of (entries || [])) {
    const sp = parseSenderPrefix(e && e.text);
    if (!sp || !sp.name) continue;
    map.set(sp.name, (map.get(sp.name) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

/* 剥掉回复/关联的引用头，返回正文。
   回复头：' > xxx\n> [[ref]]\n\n'
   关联头：' > xxx\n∝ keyword [[ref]]\n\n'
   匹配不上就原样返回。 */
   export function stripQuoteHeader(text) {
    if (!text) return '';
    let m = text.match(/^>[^\n]*\r?\n>[^\n]*\[\[[^\]]*#\^[^\]]+\]\]\r?\n+[\s]*/);
    if (m) return text.slice(m[0].length);
    m = text.match(/^>[^\n]*\r?\n∝[^\n]*\[\[[^\]]*#\^[^\]]+\]\]\r?\n+[\s]*/);
    if (m) return text.slice(m[0].length);
    /* 变体头：↻ [[~tid#^bid]] 单独一行 */
    m = text.match(/^↻\s*\[\[[^\]]*#\^[^\]]+\]\][^\n]*\r?\n+[\s]*/);
    if (m) return text.slice(m[0].length);
    return text;
  }
/* 判断一条消息是否是"回复"：开头是引用块 + 内含引用语法 */
export function isReplyMessage(text) {
  if (!text) return false;
  return /^(?:>\s[^\n]*\n)+>\s*\[\[[^\]]*#\^[^\]]+\]\]/.test(text);
}
/* ---------- 自定义语法：预处理成占位符 ---------- */
/* 哨兵常量与占位符正则在 md-custom.js —— 这里不再重复定义。
   本模块只用 preprocess / postprocess 的成品结果。 */


export function normalizeTopicRefId(tid) {
  if (!tid) return tid;
  if (/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}$/.test(tid)) return tid;
  return topicRefIdFromStamp(tid) || String(tid);
}


/* 镜像卡片：把源记录渲染成一张卡。内部不再展开镜像（防循环）。 */
    function renderMirrorHTML(tid, block) {
      /* 正常路径：blockId 全局索引 O(1)，不再为每个镜像扫 node.entries */
      let node = null, e = null;
      const hit = Store.blockEntry(block);
      if (hit && (!tid || topicRefId(hit.node) === tid)) {
        node = hit.node;
        e = hit.e;
      } else {
        node = findTopicByRefId(tid);
        if (!node) {
          return '<div class="md-mirror missing">' +
            '<div class="md-mirror-head">▣ 源话题不存在</div></div>';
        }
        /* 只有索引缺失/损坏时才走线性兜底 */
        const idx = node.entries.findIndex(x => entryBlockId(x) === block);
        if (idx < 0) {
          return '<div class="md-mirror missing">' +
            '<div class="md-mirror-head">▣ 源记录不存在</div>' +
            '<div class="md-mirror-path">' + esc(node.title) + '</div></div>';
        }
        e = node.entries[idx];
      }

      const body = renderMirrorBody(e)   // ★ 一层展开
      return '<div class="md-mirror" data-node="' + node.id + '" ' +
            'data-tid="' + tid + '" data-block="' + block + '">' +
        '<div class="md-mirror-head">' +
          '<span class="md-mirror-mark">▣</span>' +
          '<span class="md-mirror-src">来自 · ' + esc(node.title) + '</span>' +
          '<button class="md-mirror-open" data-mirror-open>打开</button>' +
        '</div>' +
        '<div class="md-mirror-body">' + body + '</div>' +
      '</div>';
    }


/* ---------- 公式溢出检测 ---------- */

let _mathRaf = null;
let _mathWatcherInstalled = false;

/* 扫一遍 root 下所有 .katex-display，真溢出才加 .scrollable。
   +2 是给 subpixel 舍入留的容差。 */
export function syncMathOverflow(root) {
  if (_mathRaf) return;
  _mathRaf = requestAnimationFrame(() => {
    _mathRaf = null;
    root = root || document;
    for (const el of root.querySelectorAll('.katex-display')) {
      /* scrollWidth 会把 nowrap 溢出的内容宽度算进去；
         clientWidth 是元素自身的可视宽度。
         +1 给 subpixel 舍入留容差。 */
      el.classList.toggle('scrollable', el.scrollWidth > el.clientWidth + 2);
    }
  });
}

/* 一次性安装：DOM 变化 / 窗口尺寸变化时重测 */
export function installMathOverflowWatcher() {
  if (_mathWatcherInstalled) return;
  _mathWatcherInstalled = true;
  const entries = document.getElementById('entries');
  if (entries) {
    new MutationObserver(() => syncMathOverflow(entries))
      .observe(entries, { childList: true, subtree: false });
  }
  /* 全屏页面（pin page / pick it / trash）用的是 document.body 下的临时节点，
     挂一个顶层 observer 兜底 */
  new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.querySelector && n.querySelector('.katex-display')) {
          syncMathOverflow(document);
          return;
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: false });

  window.addEventListener('resize', () => syncMathOverflow(document));

  /* ★ 新增：字体就绪后重测一遍，覆盖 fallback 估宽造成的误报 */
  if (document.fonts) {
    document.fonts.ready.then(() => syncMathOverflow(document));
    document.fonts.addEventListener('loadingdone', () => syncMathOverflow(document));
  }

  syncMathOverflow(document);
}

/* ---------- 渲染 ---------- */

export function renderMD(src, opts) {
  const { text, stash } = preprocess(src, {
    ...opts,
    renderMirror: renderMirrorHTML,
    resolveTopicRef: findTopicByRefId,
  });
  let html;
  try {
    html = marked.parse(text);
  } catch (e) {
    console.error('[renderMD] marked 解析失败，回退到纯文本', e);
    html = '<span>' + esc(src) + '</span>';
  }
  return postprocess(html, stash);
}

/* 渲染缓存：按片段文本缓存，LRU 上限 600 */
/* 渲染缓存：条数 + 字节双上限；LRU 淘汰 */

const MD_CACHE_MAX       = 600;
const MD_CACHE_BYTES_MAX = 8 * 1024 * 1024;   // 8 MB
let   mdCacheBytes       = 0;

export function renderMDCached(src) {
  /* ★ 含镜像的片段不缓存 —— 源改了要能立刻看到 */
  if (src.includes('![[')) return renderMD(src);

  let h = Store.mdCache.get(src);
  if (h !== undefined) {
    Store.mdCache.delete(src); Store.mdCache.set(src, h);
    return h;
  }
  h = renderMD(src);
  Store.mdCache.set(src, h);
  mdCacheBytes += src.length + h.length;

  while (Store.mdCache.size > MD_CACHE_MAX || mdCacheBytes > MD_CACHE_BYTES_MAX) {
    const k = Store.mdCache.keys().next().value;
    const v = Store.mdCache.get(k);
    if (v !== undefined) mdCacheBytes -= (k.length + v.length);
    Store.mdCache.delete(k);
  }
  return h;
}

/* 镜像内容不缓存 —— 每次从源头重取，保证同步 */
function renderMirrorBody(e) {
  return renderTextParts(
    e.text,
    p =>
      '<button type="button" class="mirror-img" title="图片存放在源话题，点击前往查看">' +
        '<span class="mi-ic">🖼</span>' +
        '<span class="mi-text">图片需到来源查看</span>' +
        (p.alt ? '<span class="mi-alt">' + esc(p.alt) + '</span>' : '') +
      '</button>',
    t => '<span class="etext">' + renderMD(t, { noEmbed: true }) + '</span>'
  ).html;
}

/** 单条片段失效 —— 编辑/删除时调用，只清该段，不动其他缓存 */
export function invalidateMDCache(src) {
  const v = Store.mdCache.get(src);
  if (v === undefined) return;
  mdCacheBytes -= (src.length + v.length);
  Store.mdCache.delete(src);
}

/** 全清 —— 重命名话题、重扫磁盘等场景 */
export function clearMDCache() {
  Store.mdCache.clear();
  mdCacheBytes = 0;
}

/* ---------- 图片拆分 ---------- */

/* 图片语法的唯一来源：alt、path（不含空白/右括号）、可选 title。
   其他模块不要自己再写 ![..](..) 正则。 */
const IMG_SRC = '!\\[([^\\]]*)\\]\\(\\s*([^)\\s]+)(?:\\s+"[^"]*")?\\s*\\)';
export const IMG_RE = new RegExp(IMG_SRC, 'g');

/** 一次遍历拿到所有图片：{ alt, path, index, raw }。新建正则，不共享 lastIndex。 */
export function imageRefs(text) {
  const re = new RegExp(IMG_SRC, 'g');
  const s = String(text || '');
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    out.push({ alt: m[1] || '', path: m[2], index: m.index, raw: m[0] });
  }
  return out;
}

/** 替换所有图片语法；repl(alt, path)。 */
export function replaceImages(text, repl) {
  const re = new RegExp(IMG_SRC, 'g');
  return String(text || '').replace(re, (m, alt, p) => repl(alt || '', p || ''));
}

export function hasImage(text) {
  return imageRefs(text).length > 0;
}

export function stripImages(text) {
  return replaceImages(text, () => ' ');
}

export function splitByImage(text) {
  const s = String(text || '');
  const parts = []; let last = 0;
  for (const r of imageRefs(s)) {
    if (r.index > last) parts.push({ t: s.slice(last, r.index) });
    parts.push({ img: r.path, alt: r.alt });
    last = r.index + r.raw.length;
  }
  if (last < s.length) parts.push({ t: s.slice(last) });
  return parts;
}

/* 图片 + Markdown 混排的统一遍历器。
   renderImage(part) / renderText(part.t) 由调用方决定具体 HTML。 */
export function renderTextParts(text, renderImage, renderText) {
  const parts = splitByImage(text || '');
  let html = '';
  let hasImg = false;
  for (const p of parts) {
    if (p.img) {
      hasImg = true;
      html += renderImage(p);
    } else if (p.t && p.t.trim()) {
      html += renderText(p.t);
    }
  }
  return { html: html || '<span class="etext"></span>', hasImg };
}

/* ---------- 解析（磁盘 → entries） ---------- */

export function parseEntries(text) {
  const out = []; let cur = null, buf = [];
  const re = /^##\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?(?:\s*[（(](已编辑(?:\s+\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)?)[）)])?\s*$/;

  const flush = () => {
    if (cur) {
      const t = unescapeEntryBody( buf.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''));
      if (t) { cur.text = t; out.push(cur); }
    }
    cur = null; buf = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) {
      flush();
      let edited = false, editedAt = null;
      if (m[9]) {
        edited = true;
        const sub = m[9].match(/^已编辑\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/);
        if (sub) {
          editedAt = parseStampToMs(sub[1], sub[2], sub[3], sub[4], sub[5], sub[6], sub[7], sub[8]);
        }
      }
      cur = {
        id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        createdAt: parseStampToMs(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]),
        edited, editedAt, text: '',
        /* ★ 新增：还原磁盘上的原始时间串（含原时区），
          保证 entryBlockId 与写盘时生成的引用稳定一致 */
        _writeStamp:
        m[1] + '-' + m[2] + '-' + m[3] + ' ' +
        m[4] + ':' + m[5] +
        (m[6] != null ? ':' + m[6] : ':00') +
        (m[7] != null ? '.' + String(m[7]).padEnd(3, '0') : '.000') +
        (m[8] || ''),
      };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/* ---------- 引用系统 ---------- */

/* topicRefId / findTopicByRefId 已迁到 tree-utils.js；
   md.js 只保留 buildRef，并 re-export 以兼容旧调用。 */

/* 构造一条 entry 的引用串。
   优先 topicId（跨重命名稳定），否则回落到路径。
   blockId 由调用方算（entryBlockId(e)）。 */
export function buildRef(node, blockId) {
  const tid = topicRefId(node);
  if (tid) return '[[~' + tid + '#^' + blockId + ']]';
  const path = pathTitles(node, '\u001f');
  return '[[' + path + '#^' + blockId + ']]';
}
