'use strict';
/* ================= entries-ops.js =================
 * 记录操作领域：编辑 / 删除 / 移动 / 多选 / 折叠 / 右键菜单。
 *
 * 从 entries.js 抽出。这些函数都属于"对一条（或多条）记录做操作"。
 *
 * 对外：
 *   startEdit / bindEdit / commitEdit
 *   enterDelConfirm / executeDelete
 *   moveEntryTo
 *   handleMultiClick / clearMultiSelect / refreshMultiUI / doFold
 *   buildEntryMenuItems
 *   wireOps({...})
 *
 * 注入（来自 entries.js）：
 *   replaceRow / renderEntries / removeEntryRow / updateTopCount
 *   setReplyCounts / renderPins / toggleEntryPin
 *   setReply / renderAll（转发自 entries.js 的 D）
 */

import { $ } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { fmtStamp } from './format.js';
import { IMG_RE, buildRef, splitByImage, invalidateMDCache } from './md.js';
import {
  persistMonthOf, pushTrash, writePins, writeFolds,
  copyAttachment, TRASH_MAX,
} from './io.js';
import { enqueue } from './writer.js';
import { pathOf } from './tree-utils.js';
import { toast, openMovePicker, confirmDialog,pushEsc } from './ui.js';
import { diffGlobalMetaFor, removeGlobalMetaFor, addGlobalMetaFor } from './meta-row.js';

/* ---------- 依赖注入 ---------- */
let D = {
  replaceRow:     () => false,
  renderEntries:  () => {},
  removeEntryRow: () => {},
  updateTopCount: () => {},
 
  setMetaCounts:  () => {},   // ★
  refreshAllRowMeta: () => {},          // ← 新增
  renderPins:     () => {},
  toggleEntryPin: () => {},
  setReply:       () => {},
  setRelevance:   () => {},
  renderAll:      () => {},
};
export function wireOps(h) { Object.assign(D, h); }

const findNode  = Store.node;
const findEntry = Store.entry;
let _multiEscOff = null;

/* ============================================================
 * 多选 + 折叠
 * ============================================================ */

export function handleMultiClick(eid, isShift) {
  if (Store.ui.merged) return;
  const n = findNode(Store.ui.selectedId); if (!n) return;
  if (isShift && Store.ui.lastMultiClick) {
    const idxMap = new Map(n.entries.map((e, i) => [e.id, i]));
    const a = idxMap.get(Store.ui.lastMultiClick), b = idxMap.get(eid);
    if (a != null && b != null) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) Store.ui.multiSelect.add(n.entries[i].id);
    }
  } else {
    if (Store.ui.multiSelect.has(eid)) Store.ui.multiSelect.delete(eid);
    else Store.ui.multiSelect.add(eid);
    Store.ui.lastMultiClick = eid;
  }
  refreshMultiUI();
}

export function refreshMultiUI() {
  document.querySelectorAll('#entries .entry-row').forEach(r => {
    r.classList.toggle('multi-selected', Store.ui.multiSelect.has(r.dataset.eid));
  });
  const bar = $('#multiBar'); if (!bar) return;
  const c = Store.ui.multiSelect.size;
  const active = c > 0 && !Store.ui.merged;

  if (!active) {
    bar.classList.remove('on');
    if (_multiEscOff) { _multiEscOff(); _multiEscOff = null; }   // ★ 出栈
    return;
  }
  bar.classList.add('on');
  bar.querySelector('.mb-count').textContent = '已选 ' + c + ' 条';
  if (!_multiEscOff) _multiEscOff = pushEsc(clearMultiSelect);    // ★ 入栈
}

export function clearMultiSelect() {
  Store.ui.multiSelect.clear();
  Store.ui.lastMultiClick = null;
  refreshMultiUI();
}

export function doFold() {
  try {
    const n = findNode(Store.ui.selectedId);
    if (!n) { toast('没有选中话题'); return; }
    const idxMap = new Map(n.entries.map((e, i) => [e.id, i]));
    const idxs = [...Store.ui.multiSelect].map(id => idxMap.get(id))
      .filter(i => i != null).sort((a, b) => a - b);
    if (idxs.length < 2) { toast('至少选两条'); return; }
    for (let i = 1; i < idxs.length; i++) {
      if (idxs[i] !== idxs[i - 1] + 1) { toast('选择的记录必须连续'); return; }
    }
    const a = idxs[0], b = idxs[idxs.length - 1];
    const fromMs = n.entries[a].createdAt;
    const toMs = n.entries[b].createdAt;
    const fold = Mutate.addFold(n, fromMs, toMs);
    if (!fold) { toast('折叠失败：时间戳异常'); return; }
    enqueue(() => writeFolds(n));
    clearMultiSelect();
    D.renderEntries();
    toast('已折叠 ' + idxs.length + ' 条');
  } catch (err) {
    console.error('[doFold] 出错', err);
    toast('折叠失败：' + (err && err.message || err));
  }
}

/* ============================================================
 * 编辑
 * ============================================================ */

/* ============================================================
 * 原子变更：文本编辑 / 删除，副作用一次做齐
 * ============================================================ */

/**
 * 对一条 entry 做文本变更。所有副作用集中在这里。
 *
 *   changeEntryText(node, entryId, () => Mutate.editEntry(...))
 *
 * 覆盖：
 *   - MD 缓存失效（对旧文本的所有片段）
 *   - 引用计数差量（diffGlobalMetaFor）
 *   - 排队持久化（persistMonthOf）
 *
 * 调用方只负责 UI 层（替换行、重绘 pins）。别再手写这三步。
 */
export function changeEntryText(node, entryId, applyFn) {
  const hit = Store.entry(entryId);
  if (!hit || hit.node !== node) return null;

  const oldText = hit.e.text;
  const result = applyFn();                  // 通常是 Mutate.editEntry(...)
  if (!result || !result.changed) return result;

  for (const p of splitByImage(oldText)) {
    if (p.t && p.t.trim()) invalidateMDCache(p.t);
  }
  diffGlobalMetaFor(result.entry, oldText, result.entry.text);
  enqueue(() => persistMonthOf(node, result.entry.createdAt));

  return result;
}

/**
 * 删除一条 entry 时的全部副作用。
 * 索引同步由 Store.removeEntry 处理（含取消置顶）。
 */
export function removeEntryWithCleanup(node, entryId) {
  const hit = Store.entry(entryId);
  if (!hit || hit.node !== node) return null;

  const e = hit.e;
  for (const p of splitByImage(e.text)) {
    if (p.t && p.t.trim()) invalidateMDCache(p.t);
  }
  removeGlobalMetaFor(e);

  return Store.removeEntry(node, entryId);   // { entry, index, wasPinned } | null
}


export function startEdit(eid, n) {
  Store.ui.editingEntry = eid;
  if (!D.replaceRow(eid, n)) { D.renderEntries(); bindEdit(eid); }
  else bindEdit(eid);
}

export function bindEdit(eid) {
  const t = document.querySelector('[data-editing="' + eid + '"] textarea'); if (!t) return;
  const row = document.querySelector('[data-eid="' + eid + '"]');
  const nid = row ? (row.dataset.node || Store.ui.selectedId) : Store.ui.selectedId;
  const sc = $('#entriesScroll');

  const grow = () => {
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.5) + 'px';
  };
  grow();
  t.focus({ preventScroll: true });
  t.setSelectionRange(t.value.length, t.value.length);

  if (row && sc) {
    requestAnimationFrame(() => {
      const r = row.getBoundingClientRect();
      const s = sc.getBoundingClientRect();
      const margin = 12;
      const tooTall = r.height > s.height - margin * 2;
      if (tooTall || r.top < s.top) sc.scrollTop += r.top - s.top - margin;
      else if (r.bottom > s.bottom) sc.scrollTop += r.bottom - s.bottom + margin;
    });
  }

  /* ★ 1. 快照原始值，用于判断"是否变过" */
  const original = t.value;
  /* ★ 2. settled 标志：Enter / Escape / commitEdit / 已处理过的 blur
         之后的 blur 不再触发任何逻辑 */
  let settled = false;

  t.addEventListener('input', grow);

  t.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      settled = true;
      commitEdit(eid, t.value, nid);
    }
    if (e.key === 'Escape') {
      e.stopPropagation();        // 不再冒泡到全局
      settled = true;
      Store.ui.editingEntry = null;
      D.renderEntries();
    }
  });

  t.addEventListener('blur', async () => {
    if (settled) return;
    if (Store.ui.editingEntry !== eid) return;   // 已被别的路径收尾
    settled = true;

    const val = t.value;
    const unchanged = val.trim() === original.trim();

    /* 没变动 / 清空 → 静默退出 */
    if (unchanged || !val.trim()) {
      Store.ui.editingEntry = null;
      D.renderEntries();
      return;
    }

    /* 有变动 → 弹提醒 */
    const ok = await confirmDialog(
      '保存修改？',
      '这条记录已被修改。要保存吗？',
      { okText: '保存', cancelText: '放弃' }
    );

    if (ok) {
      commitEdit(eid, val, nid);
    } else {
      Store.ui.editingEntry = null;
      D.renderEntries();
    }
  });
}

export function commitEdit(eid, val, nid) {
  const v = val.trim();
  const hit = findEntry(eid);
  const n = hit ? hit.node : findNode(nid || Store.ui.selectedId);
  if (!n) { Store.ui.editingEntry = null; D.renderEntries(); return; }
  if (!v) { Store.ui.editingEntry = null; D.renderEntries(); return; }

  /* ★ 变更 + 全部副作用（缓存失效 / 差量计数 / 持久化）一次做完 */
  const r = changeEntryText(n, eid, () => Mutate.editEntry(n, eid, v));
  const ent = r && r.entry;

  Store.ui.editingEntry = null;
  if (!ent || Store.ui.merged) { D.renderEntries(); return; }

  /* UI 层：镜像走整块重绘，否则只替换这一行 */
  const bid = Mutate.entryBlockId(ent);
  const mirrorCount = Store.mirrorCounts.get(bid)?.size || 0;
  if (mirrorCount > 0) D.renderEntries();
  else if (!D.replaceRow(eid, n)) D.renderEntries();

  if (r.changed) D.refreshAllRowMeta();
  D.renderPins();
}

/* ============================================================
 * 删除
 * ============================================================ */

export async function enterDelConfirm(eid, n) {
  const hit = findEntry(eid);
  if (!hit || hit.node !== n) return;
  const ent = hit.e;

  const ok = await confirmDialog(
    '删除这条记录？',
    '可在回收站中恢复或彻底删除',
    { danger: true, okText: '删除', cancelText: '取消' }
  );
  if (!ok) return;
  
  executeDelete(eid, n, ent);
  
}


export function executeDelete(eid, n, ent) {
  if (!Store.fs.ready) { toast('尚未连接文件夹，无法删除'); return; }

  const wasPinned = Mutate.isPinned(n, ent);
  const entryIdx = n.entries.indexOf(ent);
  const pinIdx   = wasPinned ? n.pinned.indexOf(ent.createdAt) : -1;
  if (entryIdx < 0) { toast('内部状态异常，请重扫'); return; }

  /* ★ 快照 —— 回滚时按位置放回，不再靠时间戳二分 */
  const snapshot = {
    id: ent.id,
    text: ent.text,
    originalMs: ent.createdAt,
    originalStamp: fmtStamp(ent.createdAt),
    deletedAt: fmtStamp(Date.now()),
    fromTopic: pathOf(n).map(x => x.title).join('/'),
    fromTopicId: n.topicId || null,
    pinned: wasPinned,
  };

  enqueue(async () => {
    try {
      const r = await pushTrash(snapshot);
      if (r && r.dropped > 0) {
        toast('回收站已满（上限 ' + TRASH_MAX + ' 条），最早 ' + r.dropped + ' 条已被清理');
      }
      await persistMonthOf(n, ent.createdAt);
      await writePins(n);
      toast('已删除，可在回收站恢复');
    } catch (err) {
      /* 回滚：按快照位置放回 */
      const cur = n.entries.indexOf(ent);
      if (cur >= 0) n.entries.splice(cur, 1);
      const at = Math.min(Math.max(entryIdx, 0), n.entries.length);
      n.entries.splice(at, 0, ent);
      Store.indexEntry(ent, n);                 // ← 手动恢复索引

      /* ★ 新增：把 meta 计数也补回来 */
      addGlobalMetaFor(ent);
      
      if (wasPinned && !n.pinned.includes(ent.createdAt)) {
        const pi = Math.min(Math.max(pinIdx, 0), n.pinned.length);
        n.pinned.splice(pi, 0, ent.createdAt);
      }

      D.renderAll();
      toast('删除失败，已恢复：' + (err.message || err));
      throw err;
    }
  });

  /* ★ 内存变更 + 缓存失效 + 计数移除 + 索引摘除（Store 内部做） */
  removeEntryWithCleanup(n, eid);

  Store.ui.multiSelect.delete(ent.id);
  if (!Store.ui.multiSelect.size) {
    const bar = $('#multiBar'); if (bar) bar.classList.remove('on');
  }

  if (Store.ui.merged) D.renderEntries();
  else { D.removeEntryRow(eid, n); D.updateTopCount(); }
  D.refreshAllRowMeta();
  D.renderPins();
}

/* ============================================================
 * 移动
 * ============================================================ */

export function moveEntryTo(ent, fromNode) {
  openMovePicker('把这条记录移到哪个话题下？', [fromNode.id], targetId => {
    const t = findNode(targetId);
    if (!t) return;

    const oldIdx = fromNode.entries.indexOf(ent);
    if (oldIdx < 0) { toast('记录已不存在'); return; }

    const wasPinned = Mutate.isPinned(fromNode, ent);
    const pinIdx = wasPinned ? fromNode.pinned.indexOf(ent.createdAt) : -1;

    /* 1. 内存：条目搬家 */
    fromNode.entries.splice(oldIdx, 1);
    let i = t.entries.length;
    while (i > 0 && t.entries[i - 1].createdAt > ent.createdAt) i--;
    t.entries.splice(i, 0, ent);
    Store.indexEntry(ent, t);

    /* 2. 内存：置顶跟着走（立刻，保证 renderAll 正确） */
    if (wasPinned) {
      Mutate.removePin(fromNode, ent);
      Mutate.addPin(t, ent);
    }

    const paths = [...ent.text.matchAll(IMG_RE)].map(m => m[2]);

    enqueue(async () => {
      try {
        for (const p of paths) {
          try { await copyAttachment(fromNode._dir, t._dir, p); }
          catch (e) { console.warn('附件复制失败', p, e); }
        }
        await persistMonthOf(fromNode, ent.createdAt);
        await persistMonthOf(t, ent.createdAt);
        if (wasPinned) {
          await writePins(fromNode);
          await writePins(t);
        }
      } catch (err) {
        /* 回滚条目位置 */
        const cur = t.entries.indexOf(ent);
        if (cur >= 0) t.entries.splice(cur, 1);
        const at = Math.min(Math.max(oldIdx, 0), fromNode.entries.length);
        fromNode.entries.splice(at, 0, ent);
        Store.indexEntry(ent, fromNode);

        /* 回滚置顶 */
        if (wasPinned) {
          Mutate.removePin(t, ent);
          if (!fromNode.pinned.includes(ent.createdAt)) {
            const pi = Math.min(Math.max(pinIdx, 0), fromNode.pinned.length);
            fromNode.pinned.splice(pi, 0, ent.createdAt);
          }
        }

        D.renderAll();
        toast('移动失败，已恢复：' + (err.message || err));
        throw err;
      }
    });

    D.renderAll();
    toast('已移动到「' + t.title + '」' +
      (paths.length ? '（含 ' + paths.length + ' 张图片）' : '') +
      (wasPinned ? '（置顶跟随）' : ''));
  });
}


/* ============================================================
 * 右键菜单
 * ============================================================ */

function refString(node, ent) {
  return buildRef(node, Mutate.entryBlockId(ent));
}

/* 每一项的构造函数 —— ctx = { n, ent, isSel, opts, D }
 *   返回菜单项对象；返回 null 表示"当前情况下不适用"，会被过滤掉。 */
const MENU_ITEMS = {
  reply: c => c.opts.readonly ? null : {
    icon: I.reply, label: '回复',
    fn: () => c.D.setReply(c.ent),
  },

  relevance: c => c.opts.readonly ? null : {
    icon: I.relevance, label: '关联',
    fn: () => c.D.setRelevance(c.ent),
  },

  copyFull: c => ({
    icon: I.copy, label: '复制全文',
    fn: () => navigator.clipboard.writeText(c.ent.text)
      .then(() => toast('已复制全文'), () => toast('复制失败')),
    split: '带引用',
    splitFn: () => {
      navigator.clipboard.writeText(refString(c.n, c.ent) + '\n' + c.ent.text)
        .then(() => toast('已复制（含引用）'))
        .catch(() => toast('复制失败'));
    },
  }),

  copyRef: c => ({
    icon: I.reply, label: '复制引用',
    fn: () => {
      navigator.clipboard.writeText(refString(c.n, c.ent))
        .then(() => toast('已复制引用'))
        .catch(() => toast('复制失败'));
    },
    split: '镜像',
    splitFn: () => {
      navigator.clipboard.writeText('!' + refString(c.n, c.ent))
        .then(() => toast('已复制镜像'))
        .catch(() => toast('复制失败'));
    },
  }),

  edit: c => c.opts.readonly ? null : {
    icon: I.pen, label: '编辑',
    fn: () => startEdit(c.ent.id, c.n),
  },

  pin: c => c.opts.readonly ? null : {
    icon: I.pin,
    label: Mutate.isPinned(c.n, c.ent) ? '取消置顶' : '置顶',
    fn: () => c.D.toggleEntryPin(c.n, c.ent),
  },

  select: c => (c.opts.readonly || Store.ui.merged) ? null : {
    icon: I.check,
    label: c.isSel ? '取消选中' : '选中',
    fn: () => handleMultiClick(c.ent.id, false),
  },

  move: c => c.opts.readonly ? null : {
    icon: I.move, label: '移动到其他话题…',
    fn: () => moveEntryTo(c.ent, c.n),
  },

  sep: c => c.opts.readonly ? null : { sep: true },

  del: c => c.opts.readonly ? null : {
    icon: I.trash, label: '删除记录', danger: true,
    fn: () => enterDelConfirm(c.ent.id, c.n),
  },
};

/* ★★★ 想调整右键菜单顺序 —— 只改下面这个数组 ★★★
 * 可用名（= MENU_ITEMS 的键）：
 *   reply   回复           relevance  关联
 *   copyFull 复制全文      copyRef    复制引用（带镜像分叉）
 *   edit    编辑           pin        置顶 / 取消置顶
 *   select  选中           move       移动到其他话题
 *   sep     分隔线         del        删除记录
 * 不适用于当前模式（readonly / merged）的项会自动跳过。 */
const MENU_ORDER = [
  'reply','edit', 
  'copyFull', 'copyRef',
  'relevance','pin', 'select',
  'move',
  'sep', 'del',
];

export function buildEntryMenuItems(hit, opts) {
  opts = opts || {};
  const ctx = {
    n: hit.node,
    ent: hit.e,
    isSel: Store.ui.multiSelect.has(hit.e.id),
    opts,
    D,
  };
  return MENU_ORDER
    .map(name => MENU_ITEMS[name] ? MENU_ITEMS[name](ctx) : null)
    .filter(x => x != null);
}