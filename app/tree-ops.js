// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE

'use strict';
/* ================= tree-ops.js =================
 * 话题的写操作：新增 / 重命名 / 移动 / 删除。
 *
 * 只做"内存 + 磁盘的数据变更"。不做渲染、不做菜单、不做手势。
 * 失败时通过 renderTree() 回滚 UI，通过 toast() 报错。
 *
 * 对外：
 *   addNode(parentId, title) → node | null
 *   renameNode(n, title)
 *   moveNode(id, targetId, pos)          pos: 'before' | 'after' | 'inside'
 *   deleteNode(id) → Promise<boolean>
 *   confirmDeleteTopic(n)                弹确认框 + deleteNode
 *
 * 注入（来自 app.js，通过 tree.js 转发）：
 *   wireTreeOps({ renderAll, savePrefs, select, setReply, setRelevance })
 */

import { Storage } from './storage.js';
import { uid, esc } from './utils.js';
import { Store } from './store.js';
import { fmtStamp, localIdFromMs } from './format.js';
import {
  sanitizeName, dirOf, uniqueName,
  moveDir, refreshHandles, writeEntriesFile, writeOrder, getTrashDir,
} from './io.js';
import { atomicWriteText } from './writeSecurity.js';
import { clearURLCacheFor, clearPendingForNode } from './image.js';
import { enqueue } from './writer.js';
import { toast, openModal, closeModal, confirmDialog } from './ui.js';
import { clearMDCache } from './md.js';
import {
  findNode, findParent, walk, pathTitles, pOf, isDesc, subtreeIds,
} from './tree-utils.js';
import { renderTree } from './tree-render.js';

/* ---------- 依赖注入 ---------- */
let D = {
  renderAll: () => {},
  savePrefs: () => {},
  /* 删除“当前话题”后要像正常切话题一样收尾（草稿 / 回复 / 关联 / 预览）。
     tree.js 在 wireTree 里注入。 */
  select: () => {},
  setReply: () => {},
  setRelevance: () => {},
};
export function wireTreeOps(h) { Object.assign(D, h); }

/* ============================================================
 * 新增
 * ============================================================ */

export function addNode(parentId, title) {
  const p = findNode(parentId); if (!p) return null;
  /* 目录名才是话题的真名（重扫时 loader 就是用目录名当 title）。
     先在内存里用 sanitize 后的名字，避免"内存显示 a/b、盘上是 a-b"，
     等 uniqueName 拿到唯一名后再把后缀补进 title。 */
  const baseTitle = sanitizeName(title);
  const n = { id: uid(), title: baseTitle, entries: [], children: [], _pending: true };
  p.children.push(n); Store.rebuildIndex();
  if (parentId !== '__root__') Store.collapsed.delete(pOf(p));

  enqueue(async () => {
    let ok = false;
    try {
      const pdir = dirOf(p);
      n._name = await uniqueName(pdir, baseTitle);
      /* 落到磁盘上的名字才是重扫后的 title；重名时这里会变成 "工作 2" */
      if (n.title !== n._name) {
        n.title = n._name;
        if (p.children.includes(n)) {
          D.savePrefs();
          D.renderAll();
        }
      }
      n._dir  = await Storage.getDir(pdir, n._name, { create: true });
      await writeEntriesFile(n);
      await writeOrder(p);
      const meta = { createdAt: fmtStamp(Date.now()), intro: '' };
      n.topicId = meta.createdAt;
      await atomicWriteText(n._dir, '_话题.json', JSON.stringify(meta, null, 2));
      ok = true;
    } finally {
      delete n._pending;
      if (!ok) {
        const i = p.children.indexOf(n);
        if (i >= 0) p.children.splice(i, 1);
        Store.unindexNode(n);
        renderTree();
      }
    }
  });

  D.savePrefs();
  return n;
}

/* ============================================================
 * 重命名
 * ============================================================ */

export function renameNode(n, title) {
  const p = findParent(n.id); if (!p) return;
  const oldTitle = n.title;
  /* 目录名是持久化的真名：sanitize 之后才可能和 _name 比较得上 */
  const nextTitle = sanitizeName(title);
  if (nextTitle !== oldTitle) {
    const oldSelf = pOf(n);
    const prefix = oldSelf + '\u0001';
    for (const k of [...Store.collapsed]) {
      if (k === oldSelf || k.startsWith(prefix)) {
        Store.collapsed.delete(k);
      }
    }
  }
  n.title = nextTitle;
  Store.touchData();
  clearMDCache();
  enqueue(async () => {
    const pdir = dirOf(p);
    const base = nextTitle;
    let dirChanged = false;
    let finalTitle = n._name || base;
    try {
      if (base !== n._name) {
        const newName = await uniqueName(pdir, base);
        finalTitle = newName;
        const nd = await moveDir(n._dir, pdir, newName);
        dirChanged = true;
        try { await Storage.removeEntry(pdir, n._name, { recursive: true }); }
        catch (e) { console.warn('[rename] 删旧目录失败（可忽略）:', e); }
        n._dir = nd; n._name = newName;
        n.title = finalTitle;   // 目录已经换了，title 必须同步（即使后面失败）
        await refreshHandles(n);
        clearURLCacheFor(n.id);
      }
      /* 重名时 uniqueName 会加后缀（"工作 2"），内存 title 必须跟着走，
         否则内存里的 pOf / findByPath / 引用回落路径都会和磁盘不一致。 */
      n.title = finalTitle;
      await writeEntriesFile(n);
      await writeOrder(p);
    } catch (e) {
      /* 目录没动 → title 回滚；目录已动 → 盘上已经是新名字，title 保持新值 */
      if (!dirChanged) n.title = oldTitle;
      D.renderAll();
      throw e;
    }
    if (dirChanged || n.title !== oldTitle) {
      D.savePrefs();
      D.renderAll();
    }
  });
  D.savePrefs();
}

/* ============================================================
 * 移动
 * ============================================================ */

export function moveNode(id, targetId, pos) {
  const n = Store.node(id); if (!n) return;
  const oldP = findParent(id);
  const newP = pos === 'inside' ? findNode(targetId) : findParent(targetId);
  if (!newP || newP.id === n.id || isDesc(n, newP)) return;
  const oldIdx = oldP.children.indexOf(n);
  if (oldIdx < 0) { console.warn('[moveNode] parent mismatch'); return; }

  oldP.children.splice(oldIdx, 1);
  Store.rebuildIndex();
  if (pos === 'inside') {
    newP.children.push(n);
    Store.collapsed.delete(pOf(newP));
  } else {
    const t = findNode(targetId);
    const i = newP.children.indexOf(t);
    newP.children.splice(pos === 'after' ? i + 1 : i, 0, n);
  }
  Store.rebuildIndex();

  const rollbackMem = () => {
    const i = newP.children.indexOf(n);
    if (i >= 0) newP.children.splice(i, 1);
    oldP.children.splice(Math.min(oldIdx, oldP.children.length), 0, n);
    Store.rebuildIndex();
    D.renderAll();
  };

  let titleChanged = false;
  enqueue(async () => {
    let dirMoved = false;
    try {
      if (newP !== oldP) {
        const npdir = dirOf(newP);
        const opdir = dirOf(oldP);
        const newName = await uniqueName(npdir, n._name);
        const nd = await moveDir(n._dir, npdir, newName);
        dirMoved = true;
        try { await Storage.removeEntry(opdir, n._name, { recursive: true }); }
        catch (e) { console.warn('[move] 删旧目录失败（可忽略）:', e); }
        n._dir = nd; n._name = newName;
        /* 目标父话题下已有同名目录 → uniqueName 会加后缀。
           内存 title 必须同步，否则重扫后名字会突然变。 */
        if (n.title !== newName) {
          n.title = newName;
          titleChanged = true;
          clearMDCache();
        }
        await refreshHandles(n);
        clearURLCacheFor(n.id);
      }
      await writeOrder(oldP);
      if (newP !== oldP) await writeOrder(newP);
    } catch (e) {
      if (!dirMoved) rollbackMem();
      else { D.savePrefs(); D.renderAll(); }
      throw e;
    }
    if (titleChanged) {
      D.savePrefs();
      D.renderAll();
    }
  });
  D.savePrefs();
}

/* ============================================================
 * 删除
 * ============================================================ */

export async function deleteNode(id) {
  if (!Store.fs.ready) { toast('尚未连接文件夹'); return false; }
  const p = findParent(id), n = Store.node(id);
  if (!p || !n) { toast('内部状态异常，请重扫'); return false; }
  const savedIndex = p.children.indexOf(n);
  if (savedIndex < 0) { toast('内部状态异常，请重扫'); return false; }
  p.children.splice(savedIndex, 1);
  Store.rebuildIndex();

  const restoreMem = () => {
    p.children.splice(savedIndex, 0, n);
    Store.rebuildIndex();
    D.renderAll();
  };

  let dirMoved = false;
  const r = await enqueue(async () => {
    let trashDir;
    try {
      trashDir = await getTrashDir(true);
    } catch (e) {
      console.error('[deleteNode] 无法创建回收站:', e);
      throw e;
    }

    const stamp = localIdFromMs(Date.now());
    const tname = n._name + '-' + stamp;
    const meta = {
      deletedAt: fmtStamp(Date.now()),
      parentPath: pathTitles(p, '/'),
      parentId: p.id === '__root__' ? null : (p.topicId || null),
      originalName: n._name,
      originalId: n.topicId || null,
    };

    try {
      /* 回收信息必须在动目录之前写进原话题：
         写失败时还没破坏任何东西，可以安全 restoreMem；
         写成功后再 move，回收站里的话题才有可恢复的位置信息。 */
      await atomicWriteText(n._dir, '_回收信息.json', JSON.stringify(meta, null, 2));

      await moveDir(n._dir, trashDir, tname);
      dirMoved = true;

      /* 目录已经进回收站 —— 删除在用户视角已经完成。
         下面两步失败都不再回滚：源目录删不掉最多留个副本；顺序文件重扫会重建。 */
      try {
        const pdir = dirOf(p);
        await Storage.removeEntry(pdir, n._name, { recursive: true });
      } catch (e) {
        console.warn('[deleteNode] 删原目录失败（可忽略）:', e);
      }
      try {
        await writeOrder(p);
      } catch (e) {
        console.warn('[deleteNode] 话题已删除，但写 _顺序.json 失败:', e);
      }
    } catch (e) {
      /* 目录还没动 → 清掉刚写的回收信息，保持原话题干净 */
      if (!dirMoved) {
        try { await Storage.removeEntry(n._dir, '_回收信息.json'); } catch (_) {}
      }
      throw e;
    }
  });

  /* 失败细节（toast / 红灯 / 权限恢复）由 writer 统一处置。
     只有“目录还没移走”时才能把内存放回去；已经移走再 restoreMem 会让
     界面显示一个磁盘上不存在的话题。 */
  if (!r.ok && !dirMoved) {
    restoreMem();
    return false;
  }
  if (!r.ok) console.warn('[deleteNode] 话题已移入回收站，但收尾失败:', r.err);

  /* 草稿/滚动位置/图片缓存只在删除真正成功后才丢 ——
     失败回滚时用户输入还在，也不会误清别的话题里没发送的图片。 */
  const dropTopicUiState = node => {
    Store.scrollMemo.delete(node.id);
    Store.ui.drafts.delete(node.id);
    clearPendingForNode(node.id);
    for (const c of node.children) dropTopicUiState(c);
  };
  dropTopicUiState(n);

  toast('已删除「' + n.title + '」');
  return true;
}

export function confirmDeleteTopic(n) {
  let topics = 0, entries = n.entries.length;
  walk(n, c => { topics++; entries += c.entries.length; });
  const md = openModal('<h3>删除「' + esc(n.title) + '」？</h3>' +
    '<p class="sub">将同时删除磁盘上的 <b>' + (topics + 1) + '</b> 个文件夹（含子话题与图片附件）与 <b>' + entries + '</b> 条记录，<br>可在回收站中恢复或彻底删除。</p>' +
    '<div class="modal-btns"><button class="m-btn ghost" data-close>取消</button>' +
    '<button class="m-btn danger" data-ok>确认删除</button></div>');
  md.querySelector('[data-close]').addEventListener('click', closeModal);
  md.querySelector('[data-ok]').addEventListener('click', async () => {
    closeModal();
    const p = findParent(n.id);
    if (!p) { toast('内部状态异常，请重扫'); return; }
    const affected = subtreeIds(n);

    const wasSelected = Store.ui.selectedId && affected.includes(Store.ui.selectedId);

    const ok = await deleteNode(n.id);
    if (!ok) return;

    const nextId = p.id !== '__root__'
      ? p.id
      : (Store.root.children[0] ? Store.root.children[0].id : null);

    if (wasSelected) {
      /* 不能直接改 selectedId：那样 textarea 里还留着已删话题的草稿，
         下一次 Enter 会把草稿写进父话题。走 select() 才能同步草稿、
         回复/关联栏、图片预览、多选状态和滚动位置。 */
      Store.ui.selectedId = null;   // 防止 select 把已删话题的 scrollTop 又记回来
      Store.ui.flashEntry = null;
      if (nextId) {
        D.select(nextId, { skipHistory: true });
        return;
      }

      /* 根目录已经没有话题了：手动把“无话题”状态清干净，
         避免留下一个看起来还能发送的 composer。 */
      Store.ui.merged = null;
      Store.ui.editingEntry = null;
      Store.ui.pinCursor = null;
      Store.ui.multiSelect.clear();
      Store.ui.lastMultiClick = null;
      Store.ui.drafts.clear();
      D.setReply(null);
      D.setRelevance(null);
      const ta = document.querySelector('#inputArea');
      if (ta) {
        ta.value = '';
        ta.style.height = 'auto';
        try { ta.dispatchEvent(new Event('input')); } catch (_) {}
      }
      D.renderAll();
      return;
    }

    D.renderAll();
  });
}