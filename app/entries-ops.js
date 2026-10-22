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
import { IMG_RE, buildRef, splitByImage, invalidateMDCache, listRelevanceTitles } from './md.js';
import {
  persistMonthOf, pushTrash, writePins, writeFolds,
  copyAttachment, TRASH_MAX,
} from './io.js';
import { enqueue } from './writer.js';
import { pathTitles } from './tree-utils.js';
import { scrollIntoViewIn, flashEl } from './scroll-utils.js';
import { openTopicLightbox } from './image.js';
import { jumpToRow } from './entries-jump.js';
import { toast, confirmDialog,pushEsc, promptInput } from './ui.js';
import { openMovePicker } from './ui-topicPicker.js';
import { diffGlobalMetaFor, removeGlobalMetaFor, addGlobalMetaFor,refreshAllRowMeta,
  scanEntryRefs } from './meta-row.js';

/* ---------- 依赖注入 ---------- */
let D = {
  replaceRow:     () => false,
  renderEntries:  () => {},
  removeEntryRow: () => {},
  updateTopCount: () => {},
 
  renderPins:     () => {},
  toggleEntryPin: () => {},
  select:         () => {},
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
  Store.touchData();
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

  /* 只替换这一行退出编辑态。
     不能整页 D.renderEntries()：那会把 loadedStart 重置到最后 PAGING.initial，
     很久以前的消息（已经向上加载出来）会消失，滚动位置也会被夹回去。 */
  const exitEditing = () => {
    Store.ui.editingEntry = null;
    const node = findNode(nid || Store.ui.selectedId);
    if (!node || !D.replaceRow(eid, node)) D.renderEntries();
  };

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
      exitEditing();
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
      exitEditing();
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
      exitEditing();
    }
  });
}

export function commitEdit(eid, val, nid) {
  const v = val.trim();
  const hit = findEntry(eid);
  const n = hit ? hit.node : findNode(nid || Store.ui.selectedId);
  if (!n) { Store.ui.editingEntry = null; D.renderEntries(); return; }
  if (!v) {
    Store.ui.editingEntry = null;
    if (!D.replaceRow(eid, n)) D.renderEntries();
    return;
  }

  /* ★ 变更 + 全部副作用（缓存失效 / 差量计数 / 持久化）一次做完 */
  const r = changeEntryText(n, eid, () => Mutate.editEntry(n, eid, v));
  const ent = r && r.entry;

  Store.ui.editingEntry = null;
  if (!ent) { D.renderEntries(); return; }

  /* UI 层：只替换编辑行；镜像行也单独替换，避免整页重绘把
     更早加载出来的记录和滚动位置一起丢掉。 */
  if (!D.replaceRow(eid, n)) { D.renderEntries(); return; }

  const bid = Mutate.entryBlockId(ent);
  const box = $('#entries');
  if (box) {
    for (const row of box.querySelectorAll('.entry-row[data-eid]')) {
      if (row.dataset.eid === eid) continue;
      const hit = Store.entry(row.dataset.eid);
      if (!hit) continue;
      if (scanEntryRefs(hit.e.text).mirror.includes(bid)) {
        D.replaceRow(hit.e.id, hit.node);
      }
    }
  }

  if (r.changed) refreshAllRowMeta();
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
    /* ★ 冻结的时间串：删除再恢复时要原样写回，blockId / 引用不能变 */
    writeStamp: ent._writeStamp || null,
    deletedAt: fmtStamp(Date.now()),
    fromTopic: pathTitles(n, '/'),
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
      throw err;
    }
  });

  /* ★ 内存变更 + 缓存失效 + 计数移除 + 索引摘除（Store 内部做） */
  removeEntryWithCleanup(n, eid);

  Store.ui.multiSelect.delete(ent.id);

  if (Store.ui.merged) D.renderEntries();
  else { D.removeEntryRow(eid, n); D.updateTopCount(); }
  refreshAllRowMeta();
  D.renderPins();
  /* 统一走多选栏刷新：会更新"已选 N 条"计数，并在清空时把 Esc handler
     出栈。以前这里手写隐藏多选栏，计数不刷新、Esc 栈留一个僵尸 handler，
     下一次 Escape 会被它吃掉。 */
  refreshMultiUI();
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
        /* 附件没搬过去就不能算"移动成功"：正文里的 ![](attachments/x.png)
           在新话题下会变成"图片缺失"，而源话题之后跑「清理未引用的图片」
           会把唯一一份副本删掉 —— 图片数据永久丢失。所以这里收集失败并抛错，
           交给外层 catch 回滚条目位置。 */
        const failed = [];
        for (const p of paths) {
          try { await copyAttachment(fromNode._dir, t._dir, p); }
          catch (e) { console.warn('附件复制失败', p, e); failed.push(p); }
        }
        if (failed.length) {
          throw new Error('附件复制失败 ' + failed.length + '/' + paths.length +
            '：' + failed[0]);
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
    icon: I.relevance, label: '建立关联…',
    fn: async () => {
      const title = await promptInput('建立关联', {
        hint: '先给这条关联起一个标题，确定后在主输入框里写正文。可从已有标题里选。',
        placeholder: '例如：同一本书 / 想起这件事',
        suggestions: listRelevanceTitles(),
        okText: '建立关联',
      });
      if (title == null) return;
      c.D.setRelevance(c.ent, title);
    },
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

/* #entries 的点击路由：徽章跳转 / 折叠 / 多选 / 图片灯箱 / 工具按钮 */
export function handleEntriesClick(e) {
  if (Store.ui.multiSelect.size) {
    const mrow = e.target.closest('.entry-row');
    const isMultiClick = mrow
      && (e.ctrlKey || e.metaKey || e.shiftKey)
      && !e.target.closest('[data-eact]')
      && !e.target.closest('.md-ref')
      && !e.target.closest('.md-tag')
      && !e.target.closest('img.eimg');
    if (!isMultiClick) clearMultiSelect();
  }

  const badge = e.target.closest('.reply-badge');
  if (badge) {
    const sc = $('#entriesScroll');
    const target = document.querySelector('#entries .entry-row[data-eid="' + badge.dataset.replyTo + '"]');
    if (target) {
      scrollIntoViewIn(sc, target, { align: 'center' });
      flashEl(target);
    } else {
      const cur = findNode(Store.ui.selectedId);
      if (cur) jumpToRow(cur, badge.dataset.replyTo);
    }
    return;
  }

  const relBadge = e.target.closest('.relevance-badge');
  if (relBadge) {
    const sc = $('#entriesScroll');
    const target = document.querySelector('#entries .entry-row[data-eid="' + relBadge.dataset.relevTo + '"]');
    if (target) {
      scrollIntoViewIn(sc, target, { align: 'center' });
      flashEl(target);
    } else {
      const cur = findNode(Store.ui.selectedId);
      if (cur) jumpToRow(cur, relBadge.dataset.relevTo);
    }
    return;
  }

  const mirrorBadge = e.target.closest('.mirror-badge');
  if (mirrorBadge) {
    const targetId = mirrorBadge.dataset.mirrorOf;
    const sc = $('#entriesScroll');
    const target = document.querySelector('#entries .entry-row[data-eid="' + targetId + '"]');
    if (target) {
      scrollIntoViewIn(sc, target, { align: 'center' });
      flashEl(target);
      return;
    }

    const hit = findEntry(targetId);
    if (!hit) { toast('找不到那条记录'); return; }
    if (hit.node.id !== Store.ui.selectedId) {
      Store.ui.flashEntry = targetId;
      D.select(hit.node.id, { noScrollRestore: true });
    } else {
      jumpToRow(hit.node, targetId);
    }
    return;
  }

  const tog = e.target.closest('.fold-toggle');
  if (tog) {
    const key = tog.dataset.fold;
    if (Store.ui.expandedFolds.has(key)) Store.ui.expandedFolds.delete(key);
    else Store.ui.expandedFolds.add(key);
    D.renderEntries();
    return;
  }

  const cxl = e.target.closest('.fold-cancel');
  if (cxl) {
    const key = cxl.dataset.fold;
    const [from, to] = key.split('|').map(Number);
    const n0 = findNode(Store.ui.selectedId);
    if (n0) {
      Mutate.removeFold(n0, from, to);
      enqueue(() => writeFolds(n0));
      Store.ui.expandedFolds.delete(key);
      D.renderEntries();
      toast('已取消折叠');
    }
    return;
  }

  const row0 = e.target.closest('.entry-row');
  if (row0 && (e.ctrlKey || e.metaKey || e.shiftKey)
      && !e.target.closest('[data-eact]')
      && !e.target.closest('.md-ref') && !e.target.closest('.md-tag')
      && !e.target.closest('img.eimg')) {
    e.preventDefault(); e.stopPropagation();
    handleMultiClick(row0.dataset.eid, e.shiftKey);
    return;
  }

  const im = e.target.closest('img.eimg.ok');
  if (im) {
    const row = im.closest('.entry-row');
    const hit = row ? findEntry(row.dataset.eid) : null;
    if (hit) openTopicLightbox(hit.node, hit.e, im.dataset.path);
    return;
  }

  const btn = e.target.closest('[data-eact]');
  if (!btn) return;
  const row = e.target.closest('[data-eid]');
  const eid = row.dataset.eid;
  const hit = findEntry(eid);
  if (!hit) return;
  const n = hit.node, ent = hit.e;
  const act = btn.dataset.eact;

  if (act === 'edit') startEdit(eid, n);
  else if (act === 'del') enterDelConfirm(eid, n);
  else if (act === 'moveEntry') moveEntryTo(ent, n);
  else if (act === 'pin') D.toggleEntryPin(n, ent);
}