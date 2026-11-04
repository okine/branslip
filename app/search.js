'use strict';
/* ================= search.js =================
 * 全局搜索：点击放大镜 / Enter 才执行，不在输入时反复扫描。
 *
 * 查询语法：
 *   "完整短语"       精确短语
 *   -词              排除
 *   #标签            标签
 *   is:pinned        只看置顶
 *   has:image        只看含图片的记录
 *   topic:工作       话题标题过滤
 *   after:2026-01-01
 *   before:2026-12-31
 *
 * 对外：
 *   initSearch({ input, button, panel, tree, onOpenTopic, onOpenEntry })
 *   runSearch()
 *   clearSearch()
 *   setQuery(text)
 *   focusSearch()
 *   parseQuery(text)      纯函数，供测试
 *   highlightText(text,q) 纯函数，供测试
 */

import { esc, badgeHTML } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { pathTitles } from './tree-utils.js';
import { fmtDay } from './format.js';
import { hasImage } from './md.js';

const TAG_RE = /(^|[\s(（])#([^\s#，。；;,.!?！？、）)]+)/g;

const state = {
  query: '',
  parsed: null,
  docs: null,
  docsRev: -1,
  topics: [],
  entries: [],
  flat: [],
  shownTopics: 50,
  shownEntries: 100,
  selected: -1,
  generation: 0,
  panelOpen: false,
  scope: 'all',   /* 'all' | 'topic' */
};

let els = null;
let callbacks = null;

/* ---------- 查询解析 ---------- */

function unquote(s) {
  const t = String(s).trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1);
  }
  return t;
}

function parseDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

export function parseQuery(text) {
  const q = {
    terms: [], phrases: [], tags: [], exclude: [],
    topic: '', pinned: false, hasImage: false,
    after: null, before: null,
  };

  const src = String(text || '');
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(src))) {
    let raw = m[1] != null ? m[1] : m[2];
    let quoted = m[1] != null;
    if (raw == null) continue;

    let neg = false;
    if (!quoted && raw.startsWith('-') && raw.length > 1) {
      neg = true;
      raw = raw.slice(1);
      if (raw.startsWith('"') && raw.endsWith('"')) {
        raw = raw.slice(1, -1);
        quoted = true;
      }
    }
    raw = raw.trim();
    if (!raw) continue;

    const low = raw.toLowerCase();
    if (quoted) {
      if (neg) q.exclude.push(low);
      else q.phrases.push(low);
      continue;
    }
    if (raw.startsWith('#')) {
      const tag = low.slice(1);
      if (tag) q.tags.push(tag);
      continue;
    }
    if (low === 'is:pinned') { q.pinned = true; continue; }
    if (low === 'has:image') { q.hasImage = true; continue; }
    if (low.startsWith('topic:')) { q.topic = unquote(raw.slice(6)).toLowerCase(); continue; }
    if (low.startsWith('after:')) {
      const t = parseDate(unquote(raw.slice(6)));
      if (t != null) q.after = t;
      continue;
    }
    if (low.startsWith('before:')) {
      const t = parseDate(unquote(raw.slice(7)));
      if (t != null) q.before = t + 864e5 - 1;
      continue;
    }
    if (neg) q.exclude.push(low);
    else q.terms.push(low);
  }

  q.terms = [...new Set(q.terms)];
  q.phrases = [...new Set(q.phrases)];
  q.tags = [...new Set(q.tags)];
  q.exclude = [...new Set(q.exclude)];
  return q;
}

function hasQuery(q) {
  return !!(q.terms.length || q.phrases.length || q.tags.length ||
    q.pinned || q.hasImage || q.topic || q.after != null || q.before != null);
}

function hasTextQuery(q) {
  return !!(q.terms.length || q.phrases.length || q.topic);
}

/* ---------- 文档缓存 ---------- */

function tagsOf(text) {
  const out = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text))) out.push(m[2].toLowerCase());
  return out;
}

/* 没有标签过滤时共享同一个空数组，避免每条结果都分配 */
const EMPTY_TAGS = [];

/* 搜索结果只显示"这条记录所在的话题"（也就是路径里离记录最近的那段）；
   完整路径放进 title 提示，悬停可见。 */
function parentPath(doc) {
  const n = doc && doc.node;
  return n ? (n.title || '') : '';
}

function buildDocs() {
  const nodes = [];

  (function rec(parent) {
    for (const n of parent.children) {
      const path = pathTitles(n);
      /* 静默话题在真正打开前不参与全局搜索（也不触发加载） */
      if (!(n.silent && !n._entriesLoaded)) {
        nodes.push({
          node: n,
          title: n.title,
          titleLower: n.title.toLowerCase(),
          path,
        });
      }
      rec(n);
    }
  })(Store.root);

  /* 不再为每一条记录建 doc 对象（100 万条 ≈ 1 GB）。
     查询时直接遍历 node.entries，只为命中的记录建结果对象。 */
  return { nodes, rev: Store.dataRevision };
}

function getDocs() {
  if (state.docs && state.docsRev === Store.dataRevision) return state.docs;
  state.docs = buildDocs();
  state.docsRev = state.docs.rev;
  lowerCache.clear();
  return state.docs;
}

/* 小写文本按 entry.id 缓存：跨查询复用；最多 5000 条，避免 1M 记录常驻小写副本。 */
const LOWER_CACHE_MAX = 5000;
const lowerCache = new Map();
function lowerOfEntry(e) {
  const id = e && e.id;
  if (!id) return String((e && e.text) || '').toLowerCase();
  let s = lowerCache.get(id);
  if (s != null) {
    lowerCache.delete(id); lowerCache.set(id, s);
    return s;
  }
  s = String(e.text || '').toLowerCase();
  if (lowerCache.size >= LOWER_CACHE_MAX) {
    lowerCache.delete(lowerCache.keys().next().value);
  }
  lowerCache.set(id, s);
  return s;
}

/* ---------- 匹配与排序 ---------- */

function textMatches(text, q) {
  for (const p of q.phrases) if (!text.includes(p)) return false;
  for (const t of q.terms) if (!text.includes(t)) return false;
  for (const x of q.exclude) if (text.includes(x)) return false;
  return true;
}

function scoreTopic(titleLower, q) {
  let score = 0;
  if (q.phrases.length) {
    for (const p of q.phrases) {
      if (titleLower === p) score += 500;
      else if (titleLower.startsWith(p)) score += 350;
      else if (titleLower.includes(p)) score += 250;
    }
  }
  for (const t of q.terms) {
    if (titleLower === t) score += 400;
    else if (titleLower.startsWith(t)) score += 260;
    else if (titleLower.includes(t)) score += 180;
  }
  return score;
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

function scoreEntry(d, q) {
  let score = 0;
  const low = lowerOfEntry(d.e);
  for (const p of q.phrases) if (low.includes(p)) score += 220;
  for (const t of q.terms) {
    score += Math.min(120, countOccurrences(low, t) * 18);
  }
  for (const tag of q.tags) if (d.tags.includes(tag)) score += 80;
  score += Math.min(30, ((d.e && d.e.text) || '').length / 120);
  return score;
}

function runQuery() {
  const q = state.parsed;
  const docs = getDocs();
  const topics = [];
  const entries = [];
  const scopeNode = state.scope === 'topic' ? Store.node(Store.ui.selectedId) : null;

  if (hasTextQuery(q) && !q.pinned && !q.hasImage && !q.tags.length && !q.after && !q.before) {
    for (const n of docs.nodes) {
      if (scopeNode && n.node !== scopeNode) continue;
      if (!textMatches(n.titleLower, q)) continue;
      if (q.topic && !n.titleLower.includes(q.topic)) continue;
      const score = scoreTopic(n.titleLower, q);
      if (score > 0) topics.push({ doc: n, score });
    }
  }

  const needText = q.terms.length > 0 || q.phrases.length > 0 || q.exclude.length > 0;
  for (const n of docs.nodes) {
    if (scopeNode && n.node !== scopeNode) continue;
    if (q.topic && !n.titleLower.includes(q.topic)) continue;
    for (const e of n.node.entries) {
      /* 先用便宜的过滤把大部分记录排除，最后才建结果对象 */
      if (q.after != null && e.createdAt < q.after) continue;
      if (q.before != null && e.createdAt > q.before) continue;
      if (q.pinned && !Mutate.isPinned(n.node, e)) continue;
      if (q.hasImage && !hasImage(e.text || '')) continue;

      let tags = EMPTY_TAGS;
      if (q.tags.length) {
        tags = tagsOf(e.text || '');
        let ok = true;
        for (const tag of q.tags) if (!tags.includes(tag)) { ok = false; break; }
        if (!ok) continue;
      }

      if (needText) {
        const low = lowerOfEntry(e);
        if (!textMatches(low, q)) continue;
        let bad = false;
        for (const x of q.exclude) if (n.titleLower.includes(x)) { bad = true; break; }
        if (bad) continue;
      }

      const d = {
        e, node: n.node, doc: n, path: n.path,
        tags,
        hasImage: q.hasImage,
      };
      entries.push({ doc: d, score: scoreEntry(d, q) });
    }
  }

  topics.sort((a, b) => b.score - a.score);
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.doc.e.createdAt - a.doc.e.createdAt;
  });

  state.topics = topics;
  state.entries = entries;
  state.shownTopics = 50;
  state.shownEntries = 100;
  state.selected = -1;
}

/* ---------- 高亮 ---------- */

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function needlesOf(q) {
  return [...q.phrases, ...q.terms].filter(Boolean);
}

export function highlightText(text, q) {
  const src = String(text || '');
  const needles = needlesOf(q || {});
  if (!needles.length) return esc(src);

  const re = new RegExp('(' + needles.map(escapeReg).join('|') + ')', 'gi');
  let out = '';
  let last = 0;
  for (const m of src.matchAll(re)) {
    out += esc(src.slice(last, m.index));
    out += '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  out += esc(src.slice(last));
  return out;
}

function snippetText(text, q) {
  const src = String(text || '');
  const lower = src.toLowerCase();
  const needles = needlesOf(q);
  let at = -1;
  let len = 0;
  for (const n of needles) {
    const i = lower.indexOf(n);
    if (i >= 0 && (at < 0 || i < at)) { at = i; len = n.length; }
  }
  if (at < 0) {
    const s = src.replace(/\s+/g, ' ').trim();
    return esc(s.length > 110 ? s.slice(0, 110) + '…' : s);
  }
  const start = Math.max(0, at - 38);
  const end = Math.min(src.length, at + len + 70);
  const pre = start > 0 ? '…' : '';
  const post = end < src.length ? '…' : '';
  return pre + highlightText(src.slice(start, end), q) + post;
}

/* ---------- 渲染 ---------- */

function showPanel(show) {
  if (!els) return;
  state.panelOpen = show;
  if (els.panel) els.panel.hidden = !show;
  if (els.tree) els.tree.hidden = show;
}

function scopeTabsHTML() {
  const hasTopic = !!Store.node(Store.ui.selectedId);
  return '<div class="search-scope">' +
    '<button type="button" data-search-scope="topic"' +
      (state.scope === 'topic' ? ' class="on"' : '') +
      (hasTopic ? '' : ' disabled') + '>当前话题</button>' +
    '<button type="button" data-search-scope="all"' +
      (state.scope === 'all' ? ' class="on"' : '') + '>全部话题</button>' +
  '</div>';
}

function renderLoading() {
  if (!els?.panel) return;
  els.panel.innerHTML = scopeTabsHTML() + '<div class="hint">搜索中…</div>';
}

function renderResults() {
  if (!els?.panel) return;
  const q = state.parsed;
  const totalTopics = state.topics.length;
  const totalEntries = state.entries.length;
  const shownTopics = state.topics.slice(0, state.shownTopics);
  const shownEntries = state.entries.slice(0, state.shownEntries);
  let h = scopeTabsHTML();
  state.flat = [];

  if (totalTopics) {
    h += '<div class="res-head">话题 · ' + totalTopics + '</div>';
    for (const r of shownTopics) {
      const idx = state.flat.length;
      state.flat.push({ type: 'topic', doc: r.doc });
      h += '<button class="res-row" data-search-idx="' + idx +
        '" data-goto="' + r.doc.node.id + '">' +
        badgeHTML(r.doc.node) +
        '<span class="main"><span>' + highlightText(r.doc.title, q) + '</span>' +
        (r.doc.path ? '<span class="path">' + esc(r.doc.path) + '</span>' : '') +
        '</span></button>';
    }
    if (totalTopics > shownTopics.length) {
      h += '<button class="res-more" data-search-more="topics">显示更多 · 还有 ' +
        (totalTopics - shownTopics.length) + ' 个话题</button>';
    }
  }

  if (totalEntries) {
    h += '<div class="res-head">记录 · ' + totalEntries + '</div>';
    for (const r of shownEntries) {
      const idx = state.flat.length;
      state.flat.push({ type: 'entry', doc: r.doc });
      h += '<button class="res-row" data-search-idx="' + idx +
        '" data-goto="' + r.doc.node.id + '" data-goto-entry="' + r.doc.e.id + '">' +
        '<span style="color:var(--ink3);flex:none">' + I.pen + '</span>' +
        '<span class="main"><span class="txt">' +
          snippetText((r.doc.e && r.doc.e.text) || '', q) + '</span>' +
        '<span class="path" title="' + esc(r.doc.path || '') + '">' +
          esc(parentPath(r.doc) || r.doc.node.title) +
          ' · ' + fmtDay(r.doc.e.createdAt) + '</span>' +
        '</span></button>';
    }
    if (totalEntries > shownEntries.length) {
      h += '<button class="res-more" data-search-more="entries">显示更多 · 还有 ' +
        (totalEntries - shownEntries.length) + ' 条</button>';
    }
  }

  if (!state.topics.length && !state.entries.length) {
    h += '<div class="hint">没有找到与「' + esc(state.query) + '」相关的内容</div>';
  }
  els.panel.innerHTML = h;
  updateSelection();
}

function updateSelection() {
  if (!els?.panel) return;
  const rows = els.panel.querySelectorAll('[data-search-idx]');
  rows.forEach((el, i) => el.classList.toggle('sel', i === state.selected));
  if (state.selected >= 0 && rows[state.selected]) {
    rows[state.selected].scrollIntoView({ block: 'nearest' });
  }
}

function render() {
  if (!state.parsed || !hasQuery(state.parsed)) {
    clearSearch();
    return;
  }
  runQuery();
  renderResults();
}

/* ---------- 对外动作 ---------- */

export function runSearch() {
  if (!els?.input) return;
  const text = els.input.value.trim();
  const gen = ++state.generation;

  if (!text) { clearSearch(); return; }
  if (state.scope === 'topic' && !Store.node(Store.ui.selectedId)) state.scope = 'all';

  state.query = text;
  state.parsed = parseQuery(text);
  if (!hasQuery(state.parsed)) { clearSearch(); return; }

  showPanel(true);
  renderLoading();

  /* 让"搜索中…"先画出来，再开始扫描 */
  requestAnimationFrame(() => {
    if (gen !== state.generation) return;
    render();
  });
}

export function clearSearch() {
  state.generation++;
  state.query = '';
  state.parsed = null;
  state.topics = [];
  state.entries = [];
  state.flat = [];
  state.selected = -1;
  if (els?.input) els.input.value = '';
  if (els?.panel) els.panel.innerHTML = '';
  showPanel(false);
}

export function setQuery(text) {
  if (!els?.input) return;
  state.scope = 'all';
  els.input.value = text || '';
  runSearch();
}

/** 从话题详情旁的搜索按钮进入：限定当前话题。 */
export function searchInTopic() {
  state.scope = 'topic';
  const n = Store.node(Store.ui.selectedId);
  if (els?.input) {
    els.input.placeholder = n ? ('搜索「' + n.title + '」…') : '先选择一个话题';
    els.input.focus();
  }
  if (String(els?.input?.value || '').trim()) runSearch();
}

export function focusSearch() {
  els?.input?.focus();
}

function openFlat(index) {
  const item = state.flat[index];
  if (!item) return;
  if (item.type === 'topic') {
    callbacks?.onOpenTopic?.(item.doc.node.id);
  } else {
    callbacks?.onOpenEntry?.(item.doc.node.id, item.doc.e.id);
  }
}

/* ---------- 初始化 ---------- */

export function initSearch(opts) {
  callbacks = opts || {};
  els = {
    input: opts.input,
    button: opts.button,
    panel: opts.panel,
    tree: opts.tree,
  };

  if (els.button) {
    els.button.addEventListener('click', () => { state.scope = 'all'; runSearch(); });
  }

  if (els.input) {
    /* 输入框清空 → 直接退出搜索状态（不用再点放大镜） */
  els.input.addEventListener('input', () => {
    if (!String(els.input.value || '').trim()) clearSearch();
  });

  els.input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        if (state.panelOpen && state.selected >= 0) openFlat(state.selected);
        else runSearch();
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        clearSearch();
        return;
      }
      if (!state.panelOpen) return;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        state.selected = Math.min(state.selected + 1, state.flat.length - 1);
        updateSelection();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        state.selected = Math.max(-1, state.selected - 1);
        updateSelection();
      }
    });
  }

  if (els.panel) {
    els.panel.addEventListener('click', ev => {
      const scopeBtn = ev.target.closest('[data-search-scope]');
      if (scopeBtn) {
        const next = scopeBtn.dataset.searchScope;
        if (next !== 'topic' && next !== 'all') return;
        if (next === 'topic' && !Store.node(Store.ui.selectedId)) return;
        if (state.scope === next) return;
        state.scope = next;
        if (state.parsed && hasQuery(state.parsed)) {
          runQuery();
          renderResults();
        }
        return;
      }
      const more = ev.target.closest('[data-search-more]');
      if (more) {
        if (more.dataset.searchMore === 'topics') state.shownTopics += 50;
        else state.shownEntries += 100;
        renderResults();
        return;
      }
      const row = ev.target.closest('[data-search-idx]');
      if (row) {
        state.selected = +row.dataset.searchIdx;
        openFlat(state.selected);
      }
    });
  }

  showPanel(false);
}
