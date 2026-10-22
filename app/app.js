// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE

'use strict';
/* ================= app.js =================
 * 启动器 + 主控编排。
 *
 * 包含：
 *   - IndexedDB 句柄持久化
 *   - 偏好读写（localStorage）
 *   - 主区编排（renderTop / renderAll）
 *   - DeepSeek 导入
 *   - 图标初始化 / 全局快捷键 / 侧栏按钮
 *   - 启动流程（gate / connect / 权限）
 *   - 所有 wireXxx 注入
 *
 */
import {
  boot, wireBoot, connect,
  loadPrefs, savePrefs, changeFolder,
} from './boot.js';
import { Store, draftTopicIds } from './store.js';
import { Storage } from './storage.js';
import { PLATFORM, invoke, currentWindow } from './platform.js';
import { $, esc } from './utils.js';
import { I } from './icons.js';
import {
  rewriteAllOrders,
} from './io.js';
import { clearRuntimeCaches } from './cacheClear.js';
import { resetMeta } from './meta-row.js';
import { 
  toast, runTopEsc, confirmDialog
} from './ui.js';
import { scanChildren, rescanFromDisk, wireLoader } from './loader.js';
import { enqueue, waitForIdle, installExitGuard } from './writer.js';
import {
  findNode, findByPath, pathOf, pOf, findTopicByRefId, collapseAll,
} from './tree-utils.js';
import {
  select, wireTree, viewBack, pushViewState
} from './tree.js';
import { renderTree } from './tree-render.js';
import { initSearch, setQuery } from './search.js';
import {
  renderEntries, wireEntries,
} from './entries.js';
import {
    jumpToBlock, jumpToStamp, jumpToRow, maybeLoadEarlier, loadEarlier,
  } from './entries-jump.js';
// 新增
import {
  collectMerged, exitMerge, renderMerged, wireMerge,
} from './entries-merge.js';

import {
  setReply, refreshPreview, wireComposer, setRelevance,
} from './composer.js';
import { wireTrash } from './trash.js';
import { wireImage } from './image.js';
import { initFixedButtons, syncFixedButtons } from './fixed-buttons.js';








/* 调试用：网页版里模块变量不是全局，控制台需要它来查状态 */
if (typeof window !== 'undefined') window.__SZJ = { Store, maybeLoadEarlier, loadEarlier };

/* 先建固定按钮；重扫/换文件夹由 app 提供，导入流程由 fixed-buttons 自己持有 */
initFixedButtons({
  renderAll,
  select,
  onRescan: rescanFromDisk,
  onChangeFolder: changeFolder,
});


/* ============================================================
 * 主区编排
 * ============================================================ */

function renderTop() {
  const cr = $('#crumbs');

  if (Store.ui.merged) {
    const list = collectMerged();
    cr.innerHTML = '<span class="crumb cur">' +
      (Store.ui.merged === 'all' ? '全部话题' : ('合并 ' + Store.ui.merged.length + ' 个话题')) + '</span>';
    $('#topCount').textContent = list.length + ' 条记录';
    return;
  }

  const n = findNode(Store.ui.selectedId);
  if (!n) {
    cr.innerHTML = '<span class="crumb cur">时枝笺</span>';
    $('#topCount').textContent = '';
    return;
  }
  const p = pathOf(n);
  cr.innerHTML = p.map((x, i) =>
    '<button class="crumb' + (i === p.length - 1 ? ' cur' : '') +
    '" data-crumb="' + x.id + '">' + esc(x.title) + '</button>'
  ).join('<span class="sep">›</span>');
  $('#topCount').textContent = n.entries.length + ' 条记录';
}

function updateComposer() {
  const merged = !!Store.ui.merged;
  const n = findNode(Store.ui.selectedId);
  const ta = $('#inputArea');
  const sb = $('#sendBtn');

  ta.disabled = merged;
  ta.placeholder = merged
    ? '时间流视图下不可写入，请先选一个话题'
    : (n ? '记一条到「' + n.title + '」…' : '');
  if (sb) sb.disabled = merged;
}

function renderMain() { renderTop(); renderEntries(); updateComposer(); }
function renderAll() { renderTree(); renderMain(); syncFixedButtons(); }

function updateNavBackTop() {
  const topbar = document.querySelector('#topbar');
  const th = topbar ? topbar.offsetHeight : 60;

  /* 恒定预留出置顶条的高度：
     chip 38px + pin-bar 上下 padding 各 6px = 50px
     无论置顶条显示与否，这段空间都空着 */
  const PIN_BAR_RESERVE = 50;
  const GAP = 10;

  document.documentElement.style.setProperty(
    '--nav-btn-top',
    (th + PIN_BAR_RESERVE + GAP) + 'px'
  );
}

const topbarEl = document.querySelector('#topbar');
if (topbarEl) new ResizeObserver(updateNavBackTop).observe(topbarEl);
window.addEventListener('resize', updateNavBackTop);
updateNavBackTop();

/* ============================================================
 * 图标初始化
 * ============================================================ */

$('#searchIcon').innerHTML = I.search;
$('#newRootBtn').innerHTML = I.plus + '<span>新建根话题</span>';
$('#hamburger').innerHTML = I.menu;
$('#attachBtn').innerHTML = I.clip;
$('#sendBtn').innerHTML = I.send;

initSearch({
  input: $('#searchInput'),
  button: $('#searchIcon'),
  panel: $('#searchPanel'),
  tree: $('#treeScroll'),
  onOpenTopic: id => select(id),
  onOpenEntry: (nodeId, entryId) => {
    select(nodeId);
    Store.ui.flashEntry = entryId;
    renderEntries();
  },
});

/* ============================================================
 * 全局快捷键 + document 事件委托
 * ============================================================ */

// app.js —— 唯一的 Escape handler
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;

  /* ★ 编辑态优先：焦点在输入框里也要能退出编辑 */
  if (Store.ui.editingEntry &&
      !(e.target.closest && e.target.closest('[data-editing]'))) {
    Store.ui.editingEntry = null;
    renderEntries();
    return;
  }
  /* ★ 焦点在输入框里 → 交给输入框自己处理 */
  if (e.target.matches && e.target.matches('input,textarea')) return;

  /* ★ 唯一入口：栈里有什么就关什么 */
  runTopEsc();
});

/* Android 硬件返回键：MainActivity 用 evaluateJavascript 调这里。
   'handled' = 关掉了一层（菜单/弹窗/侧栏/编辑态）；
   'draft'   = 没层可关、但有草稿 → 原生侧提示"再按一次退出"；
   'none'    = 什么都没有 → 原生侧提示"再按一次退出"。 */
window.__shBack = () => {
  if (Store.ui.editingEntry) {
    Store.ui.editingEntry = null;
    renderEntries();
    return 'handled';
  }
  if (runTopEsc()) return 'handled';
  return draftTopicIds().length ? 'draft' : 'none';
};


document.addEventListener('click', e => {
  /* ── 1. 镜像卡头：打开源 ── */
  const mo = e.target.closest('[data-mirror-open]');
  if (mo) {
    const card = mo.closest('.md-mirror');
    if (card) {
      const tid = card.dataset.tid;
      const block = card.dataset.block;
      const node = findTopicByRefId(tid);
      if (node) {
        if (Store.ui.merged) exitMerge();
        select(node.id);
        if (block) setTimeout(() => jumpToBlock(node, block), 80);
      }
    }
    return;
  }

  /* ── 2. 代码块复制 ── */
  const cp = e.target.closest('.md-pre-copy');
  if (cp) {
    const code = cp.closest('.md-pre-wrap').querySelector('code');
    if (code) {
      navigator.clipboard.writeText(code.textContent)
        .then(() => toast('代码已复制'))
        .catch(() => toast('复制失败'));
    }
    return;
  }

  /* ══════════════════════════════════════════════════════════
   * ★ 以下两段必须放在 .md-quote.collapsible 之前
   * ══════════════════════════════════════════════════════════ */

  /* ── 3. 内部引用 → 跨话题跳转 ── */
  const ref = e.target.closest('.md-ref');
  if (ref) {
    const tid   = ref.dataset.topicId;
    const path  = ref.dataset.path;
    const stamp = ref.dataset.stamp;
    const block = ref.dataset.block;

    let node = null;
    if (tid) {
      node = findTopicByRefId(tid);
      if (!node) { toast('引用的话题不存在（或已被彻底删除）'); return; }
    } else {
      const segs = (path || '').split(/[\/\u001f]/).map(s => s.trim()).filter(Boolean);
      node = segs.length ? findByPath(segs.join('\u0001')) : null;
      if (!node) { toast('引用的话题不存在：' + path); return; }
    }

    if (Store.ui.merged) exitMerge();

    if (!Store.ui.merged && node.id === Store.ui.selectedId) {
      const sc = $('#entriesScroll');
      pushViewState({
        nodeId: Store.ui.selectedId,
        scrollTop: sc ? sc.scrollTop : 0,
      });
    } else {
      select(node.id);
    }

    if (block) setTimeout(() => jumpToBlock(node, block), 80);
    else if (stamp) setTimeout(() => jumpToStamp(node, stamp), 80);
    return;
  }

  /* ── 4. ★新增：关联头 → 跳到被关联的那条 ── */
  const relHead = e.target.closest('.relevance-head');
  if (relHead) {
    const topicRef = relHead.dataset.relevTopic;   // '~tid' 或路径（可能没有）
    const block    = relHead.dataset.relevBlock;   // bid

    let node = null;
    if (topicRef && topicRef.startsWith('~')) {
      node = findTopicByRefId(topicRef.slice(1));
    } else if (topicRef) {
      const segs = topicRef.split(/[\/\u001f]/).map(s => s.trim()).filter(Boolean);
      node = segs.length ? findByPath(segs.join('\u0001')) : null;
    }
    /* 没有 topicRef（老格式 / entries-render.js 还没改）→ 兜底当前话题 */
    if (!node) node = Store.node(Store.ui.selectedId);
    if (!node) { toast('找不到关联的目标'); return; }

    if (Store.ui.merged) exitMerge();
    select(node.id);
    if (block) setTimeout(() => jumpToBlock(node, block), 80);
    return;
  }

  /* ══════════════════════════════════════════════════════════
   * 上面两段都 return 之后，才轮到"引用块展开/收起"兜底
   * ══════════════════════════════════════════════════════════ */

  /* ── 5. 长引用块展开/收起 ── */
  const q = e.target.closest('.md-quote.collapsible');
  if (q) { q.classList.toggle('expanded'); return; }

  /* ── 6. #标签 / 快捷标记 → 左栏搜索 ── */
  const tg = e.target.closest('.md-tag,.quick-tag');
  if (tg) {
    const tag = tg.dataset.tag || (tg.textContent.startsWith('#') ? tg.textContent.slice(1) : '');
    if (Store.ui.merged) exitMerge();
    setQuery('#' + tag);
    return;
  }

  /* ── 7. 时间流来源标签 → 跳回原话题 ── */
  const tag = e.target.closest('.src-tag'); if (!tag) return;
  const eid = tag.closest('[data-eid]').dataset.eid;
  const nid = tag.dataset.src;
  exitMerge();
  select(nid);
  Store.ui.flashEntry = eid;
  renderEntries();
});



/* ============================================================
 * 侧栏按钮
 * ============================================================ */


/* ============================================================
 * 启动流程
 * ============================================================ */


/*左箭头绑定返回*/
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' && e.key !== 'ArrowLeft' && e.key !== '[') return;
  if (e.target.matches && e.target.matches('input,textarea')) return;

  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); viewBack(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === '[') { e.preventDefault(); viewBack(); return; }
});





/* ============================================================
 * Wire 注入
 * ============================================================ */

wireEntries({
  setReply,
  setRelevance,   // ★
  renderAll,
  renderMerged,
  select,
});
wireTrash({ renderAll });
wireTree({ renderAll, savePrefs, refreshPreview });
wireComposer({ renderAll });
wireMerge({ renderAll });
wireImage({ jumpToRow });
wireBoot({ renderAll });
wireLoader({
  renderAll, select, enqueue, waitForIdle,
  clearCaches: () => clearRuntimeCaches(),
  resetMeta, toast, confirmDialog,
});
installExitGuard();
export { boot };
/* ============================================================
 * 启动
 * ============================================================ */

