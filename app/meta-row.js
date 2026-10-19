'use strict';
/* ================= meta-row.js =================
 * entry 脚标（meta-row）领域。
 *
 * 三层职责：
 *   scanEntryRefs           纯函数：扫一段文本，返回三类 blockId
 *   renderMetaRow           纯渲染：一条 entry → meta-row HTML
 *   replaceMetaRow          DOM：就地替换某一行的 meta-row
 *
 * 聚合与增量更新：
 *   buildGlobalMetaCounts()    全库 → Map<bid, Set<eid>> × 3
 *   addGlobalMetaFor(e)        追加：往 Store 的 Map 里塞
 *   diffGlobalMetaFor(e, ...)  编辑：差量更新
 *   removeGlobalMetaFor(e)     删除：从 Map 里移除
 *
 * 数据结构：三条 Map<blockId, Set<entryId>>。
 *   count = set.size
 *   first = set.values().next().value（插入顺序的第一个）
 *
 * 依赖：utils / icons / store / mutate / format / tree-utils
 */

import { esc, $ } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { fmtTime, fmtFull } from './format.js';
import { walk } from './tree-utils.js';

/* ---------- 正则 ---------- */

/* 通用引用：抓 blockId，! 前缀决定是否镜像 */
const RE_REF = /(!?)\[\[(?:~[A-Za-z0-9_-]+|[^\[\]|#^]+)#\^([A-Za-z0-9_-]+)(?:\|[^\[\]]*)?\]\]/g;
/* 关联头：∝ 关键字 [[...]] */
const RE_REL = /^\s*∝\s*[^\[]*\[\[[^\]]+#\^([^\]]+)\]\]/m;

/* ---------- 纯函数：扫文本 ---------- */

/**
 * 扫一段 entry 文本，返回它引用的所有 blockId，按类别分。
 * 同一条 entry 里重复引用同一个 blockId，只算一次。
 *
 * @returns {{ reply: string[], relevance: string[], mirror: string[] }}
 */
export function scanEntryRefs(text) {
  const out = { reply: [], relevance: [], mirror: [] };
  if (!text) return out;

  const relMatch = text.match(RE_REL);
  if (relMatch) out.relevance.push(relMatch[1]);

  /* 剥掉关联头那一行，剩下的扫普通引用 */
  const scan = relMatch ? text.replace(RE_REL, '') : text;

  const seen = new Set();
  RE_REF.lastIndex = 0;
  let m;
  while ((m = RE_REF.exec(scan))) {
    const kind = m[1] === '!' ? 'mirror' : 'reply';
    const bid = m[2];
    const key = kind + '\u0000' + bid;
    if (seen.has(key)) continue;
    seen.add(key);
    out[kind].push(bid);
  }
  return out;
}

/* ---------- 渲染 ---------- */

export function renderMetaRow(e, node) {
  const pinned = node && Mutate.isPinned(node, e);
  const bid = Mutate.entryBlockId(e);

  /* Store 里的三条 Map<bid, Set<eid>> */
  const rcSet  = Store.replyCounts.get(bid);
  const rlcSet = Store.relevanceCounts.get(bid);
  const mcSet  = Store.mirrorCounts.get(bid);

  const rc  = rcSet  ? { count: rcSet.size,  first: rcSet.values().next().value }  : null;
  const rlc = rlcSet ? { count: rlcSet.size, first: rlcSet.values().next().value } : null;
  const mc  = mcSet  ? { count: mcSet.size,  first: mcSet.values().next().value }  : null;

  const metaParts = [fmtTime(e.createdAt)];
  let metaTitle = '';
  if (e.edited) {
    metaParts.push('已编辑');
    if (e.editedAt) metaTitle = '最后编辑于 ' + fmtFull(e.editedAt);
  }

  const BADGE_ORDER = ['pin', 'reply', 'relevance', 'mirror'];
  const m = {
    pin: pinned ? '<span class="pin-badge" title="已置顶">' + I.pinSolid + '</span>' : '',
    reply: rc ? '<button class="reply-badge" data-reply-to="' + esc(rc.first) +
      '" title="查看第一条回复">↩ ' + rc.count + '</button>' : '',
    relevance: rlc ? '<button class="relevance-badge" data-relev-to="' + esc(rlc.first) +
      '" title="查看第一条关联">' + I.relevance + ' ' + rlc.count + '</button>' : '',
    mirror: mc ? '<button class="mirror-badge" data-mirror-of="' + esc(mc.first) +
      '" title="查看第一处镜像">▣ ' + mc.count + '</button>' : '',
  };

  return '<span class="meta-row">' +
    BADGE_ORDER.map(k => m[k]).join('') +
    '<span class="meta"' + (metaTitle ? ' title="' + esc(metaTitle) + '"' : '') + '>' +
      metaParts.join(' · ') +
    '</span></span>';
}

/* ---------- 就地替换 ---------- */

export function replaceMetaRow(row, e, n) {
  if (!row) return false;
  const old = row.querySelector(':scope > .entry > .meta-row');
  if (!old) return false;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMetaRow(e, n);
  old.replaceWith(tmp.firstElementChild);
  return true;
}

/* ---------- 聚合（全量） ---------- */

/**
 * 全库：扫所有话题的所有 entry，返回三条 Map<bid, Set<eid>>。
 * 冷启动时调一次，之后靠增量更新维持。
 */
export function buildGlobalMetaCounts() {
  const reply     = new Map();
  const mirror    = new Map();
  const relevance = new Map();

  const push = (bag, bid, eid) => {
    let set = bag.get(bid);
    if (!set) { set = new Set(); bag.set(bid, set); }
    set.add(eid);
  };

  walk(Store.root, n => {
    for (const e of n.entries) {
      const refs = scanEntryRefs(e.text);
      for (const bid of refs.reply)     push(reply,     bid, e.id);
      for (const bid of refs.mirror)    push(mirror,    bid, e.id);
      for (const bid of refs.relevance) push(relevance, bid, e.id);
    }
  });

  return { reply, mirror, relevance };
}

/* ---------- 增量更新 ---------- */

/**
 * 追加：把 e 的引用塞进 Store 的三条 Map。
 * Store 未构建过（isMetaBuilt() 为 false）时什么都不做 —— 下次
 * ensureGlobalMeta() 会全量重建，不需要提前维护。
 */
export function addGlobalMetaFor(e) {
  if (!Store.isMetaBuilt()) return;
  const refs = scanEntryRefs(e.text);
  const bags = {
    reply:     Store.replyCounts,
    relevance: Store.relevanceCounts,
    mirror:    Store.mirrorCounts,
  };
  for (const kind of ['reply', 'relevance', 'mirror']) {
    for (const bid of refs[kind]) {
      let set = bags[kind].get(bid);
      if (!set) { set = new Set(); bags[kind].set(bid, set); }
      set.add(e.id);
    }
  }
}

/**
 * 编辑：把 e 的引用从 oldText 对应的那些 Set 里删掉，
 * 加到 newText 对应的那些 Set 里。
 */
export function diffGlobalMetaFor(e, oldText, newText) {
  if (!Store.isMetaBuilt()) return;
  const before = scanEntryRefs(oldText);
  const after  = scanEntryRefs(newText);

  const bags = {
    reply:     Store.replyCounts,
    relevance: Store.relevanceCounts,
    mirror:    Store.mirrorCounts,
  };

  for (const kind of ['reply', 'relevance', 'mirror']) {
    const b = new Set(before[kind]);
    const a = new Set(after[kind]);
    const bag = bags[kind];

    /* 移除：before - after */
    for (const bid of b) {
      if (a.has(bid)) continue;
      const set = bag.get(bid);
      if (!set) continue;
      set.delete(e.id);
      if (!set.size) bag.delete(bid);
    }
    /* 添加：after - before */
    for (const bid of a) {
      if (b.has(bid)) continue;
      let set = bag.get(bid);
      if (!set) { set = new Set(); bag.set(bid, set); }
      set.add(e.id);
    }
  }
}

/**
 * 删除：把 e 的引用从 Store 的三条 Map 里全部撤掉。
 */
export function removeGlobalMetaFor(e) {
  if (!Store.isMetaBuilt()) return;
  const refs = scanEntryRefs(e.text);
  const bags = {
    reply:     Store.replyCounts,
    relevance: Store.relevanceCounts,
    mirror:    Store.mirrorCounts,
  };
  for (const kind of ['reply', 'relevance', 'mirror']) {
    for (const bid of refs[kind]) {
      const set = bags[kind].get(bid);
      if (!set) continue;
      set.delete(e.id);
      if (!set.size) bags[kind].delete(bid);
    }
  }
}

/* ---------- 全局表维护 / 行内刷新 ---------- */

/**
 * 冷启动后第一次渲染前调一次。之后靠 addGlobalMetaFor /
 * diffGlobalMetaFor / removeGlobalMetaFor 增量维持。
 */
export function ensureGlobalMeta() {
  if (Store.isMetaBuilt()) return;
  const g = buildGlobalMetaCounts();
  Store.setMetaCounts(g.reply, g.mirror, g.relevance);
}

/** 刷当前 DOM 里所有行的 meta-row。编辑 / 删除后用。 */
export function refreshAllRowMeta() {
  const box = $('#entries');
  if (!box) return;
  for (const row of box.querySelectorAll('.entry-row[data-eid]')) {
    const hit = Store.entry(row.dataset.eid);
    if (!hit) continue;
    replaceMetaRow(row, hit.e, hit.node);
  }
}

/**
 * 精确刷新：只更新"被这条 entry 引用"的那几行的 meta-row。
 * append 时用。
 */
export function refreshMetaForRefs(e) {
  const box = $('#entries');
  if (!box) return;
  const refs = scanEntryRefs(e.text);
  const bids = new Set([...refs.reply, ...refs.relevance, ...refs.mirror]);
  if (!bids.size) return;
  for (const row of box.querySelectorAll('.entry-row[data-eid]')) {
    const hit = Store.entry(row.dataset.eid);
    if (!hit) continue;
    if (!bids.has(Mutate.entryBlockId(hit.e))) continue;
    replaceMetaRow(row, hit.e, hit.node);
  }
}