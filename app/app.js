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
  loadPrefs, savePrefs, collapseAll,
} from './boot.js';
import { Store } from './store.js';
import { Storage } from './storage.js';
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
import { scanChildren } from './loader.js';
import { enqueue,waitForIdle } from './writer.js';
import {
  findNode, findByPath, pathOf, pOf, findTopicByRefId,
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
    jumpToBlock, jumpToStamp, jumpToRow,
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







/* 先建固定按钮；重扫/换文件夹由 app 提供，导入流程由 fixed-buttons 自己持有 */
initFixedButtons({
  renderAll,
  select,
  onRescan: rescanFromDisk,
  onChangeFolder: changeFolder,
});

/* 所有存在未发送草稿的话题 id（按写入顺序） */
function draftTopicIds() {
  const ids = new Set(Store.ui.drafts.keys());
  const cur = Store.ui.selectedId;
  const ta  = document.querySelector('#inputArea');
  /* 当前话题的 textarea 可能还没触发 input（极端情况），补一道保险 */
  if (cur && ta && ta.value.trim()) ids.add(cur);
  return [...ids];
}

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

async function rescanFromDisk() {
  if (!Store.fs.ready) { toast('尚未连接文件夹'); return; }

   /* ★ 新增：先问要不要等 pending 写完 */
   if (Store.fs.pending > 0) {
    const wait = await confirmDialog(
      '还有写入未完成',
      '有 ' + Store.fs.pending + ' 个磁盘写入任务正在排队。\n' +
      '重新读取磁盘前建议先等它们完成，否则可能读到旧内容。',
      { okText: '等待完成', cancelText: '直接重扫' }
    );
    if (wait) {
      toast('等待写入完成…');
      await waitForIdle();
    }
  }
  /* 1. 检查未保存内容，弹确认 */
  const taBefore = document.querySelector('#inputArea');
  const draft = (taBefore && taBefore.value.trim()) ? taBefore.value : null;
  const editing = Store.ui.editingEntry ||
                  Store.ui.renaming      || Store.ui.creatingParent;
  /* ★ 新增：草稿跳转 —— 优先于“未保存内容”那条提示 */
const draftIds = draftTopicIds();
if (draftIds.length) {
  const first = findNode(draftIds[0]);
  const name  = first ? first.title : '（已删除的话题）';
  const more  = draftIds.length > 1 ? '（另有 ' + (draftIds.length - 1) + ' 个）' : '';
  const go = await confirmDialog(
    '有未发送的草稿',
    '有 ' + draftIds.length + ' 个话题里存在未发送的草稿，最早的一个是「' + name + '」' + more + '。\n' +
    '是否先跳过去看一眼？',
    { okText: '去看看', cancelText: '继续重扫' }
  );
  if (go) { select(draftIds[0]); return; }
}
  if (draft || editing) {
    const ok = await confirmDialog(
      '重新读取磁盘',
      '当前有未保存的输入框草稿或正在编辑的记录，重新读取会丢弃编辑。要继续吗？',
      { danger: true, okText: '继续' }
    );
    if (!ok) return;
  }

  /* 2. 记下草稿对应的路径 —— rescan 后按路径找回来 */
  const draftPath = (draft && Store.ui.selectedId)
    ? (() => {
        const n = findNode(Store.ui.selectedId);
        return n ? pOf(n) : null;
      })()
    : null;


  enqueue(async () => {
    Store.root.children = await scanChildren(Store.dir);
    Store.rebuildIndex();
    clearRuntimeCaches();
    resetMeta();
    /* ★ 重扫后：用新扫出来的顺序重写所有 _顺序.json */
    try {
      const cnt = await rewriteAllOrders(Store.root);
      console.log('[rescan] 已重写 ' + cnt + ' 个顺序文件');
    } catch (e) {
      console.warn('[rescan] 重写顺序失败', e);
    }
    /* ★ 新增 */
    Store.ui.viewHistory = [];
    Store.ui.drafts.clear();
    Store.ui.viewCursor = -1;
    history.replaceState({ root: true }, '');
    /* ★ 新增：重扫后折叠全部 */
    Store.collapsed.clear();
    collapseAll();

    /* 3. 清掉一切指向旧对象的编辑态 */
    Store.ui.editingEntry    = null;
    Store.ui.creatingParent  = null;
    Store.ui.renaming        = null;

    const prefs = loadPrefs();
    const t = prefs.sel ? findByPath(prefs.sel) : null;
    Store.ui.selectedId = null;
    renderAll();
    if (t) select(t.id);
    else if (Store.root.children[0]) select(Store.root.children[0].id);

    /* 4. 恢复草稿 —— 仅当话题仍是当前选中时 */
    if (draft && draftPath) {
      const restored = findByPath(draftPath);
      if (restored && restored.id === Store.ui.selectedId) {
        const ta2 = document.querySelector('#inputArea');
        if (ta2 && !ta2.value) {
          ta2.value = draft;
          ta2.dispatchEvent(new Event('input'));   // 触发 autoGrow + refreshPreview
        }
      }
    }

    toast('已从磁盘重新读取');
  });
}

/*提醒*/
async function changeFolder() {
  /* ── Tauri 分支 ── */
  if (Storage.isTauri) {
    let dir;
    try {
      dir = await window.__TAURI__.core.invoke('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: '选择存储文件夹' },
      });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('无法打开文件夹：' + (e.message || e));
      return;
    }
    if (!dir) return;

    /* 与 Web 版保持一致的确认逻辑（未写入 / 草稿提示） */
    if (Store.fs.pending > 0) {
      const ok = await confirmDialog(
        '还有写入未完成',
        '当前有 ' + Store.fs.pending + ' 个磁盘写入任务在排队。\n' +
        '现在切换文件夹会中断它们。',
        { danger: true, okText: '仍然切换' }
      );
      if (!ok) return;
    }
    const draftIds = draftTopicIds();
    if (draftIds.length) {
      const first = findNode(draftIds[0]);
      const name = first ? first.title : '（已删除的话题）';
      const go = await confirmDialog(
        '有未发送的草稿',
        '有 ' + draftIds.length + ' 个话题里存在未发送的草稿，最早的一个是「' + name + '」。\n' +
        '切换文件夹会丢弃这些草稿。要先去处理吗？',
        { okText: '去看看', cancelText: '仍然切换' }
      );
      if (go) { select(draftIds[0]); return; }
    }

    enqueue(async () => { await connect(dir); });
    return;
  }
  /* ① 同步段：只做无 IO 的事 */
  const opts = { mode: 'readwrite' };
  if (Store.dir) opts.startIn = Store.dir;

  /* ② picker 必须是第一个 await */
  let h;
  try {
    h = await window.showDirectoryPicker(opts);
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('无法打开文件夹：' + (e.message || e));
    return;
  }

  /* ③ 之后再弹确认框 */
  if (Store.fs.pending > 0) {
    const ok = await confirmDialog(
      '还有写入未完成',
      '当前有 ' + Store.fs.pending + ' 个磁盘写入任务在排队。\n' +
      '现在切换文件夹会中断它们。',
      { danger: true, okText: '仍然切换' }
    );
    if (!ok) return;
  }
  /* ★ 新增：草稿跳转 —— 放在确认框之前，因为切文件夹会丢 drafts */
  const draftIds = draftTopicIds();
  if (draftIds.length) {
    const first = findNode(draftIds[0]);
    const name  = first ? first.title : '（已删除的话题）';
    const go = await confirmDialog(
      '有未发送的草稿',
      '有 ' + draftIds.length + ' 个话题里存在未发送的草稿，最早的一个是「' + name + '」。\n' +
      '切换文件夹会丢弃这些草稿。要先去处理吗？',
      { okText: '去看看', cancelText: '仍然切换' }
    );
    if (go) { select(draftIds[0]); return; }
  }

  enqueue(async () => { await connect(h); });
}

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
export { boot };
/* ============================================================
 * 启动
 * ============================================================ */

