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
 *   wireTreeOps({ renderAll, savePrefs })
 */

import { Storage } from './storage.js';
import { uid, esc } from './utils.js';
import { Store } from './store.js';
import { fmtStamp, localIdFromMs } from './format.js';
import {
  atomicWriteText, sanitizeName, dirOf, uniqueName,
  moveDir, refreshHandles, writeEntriesFile, writeOrder, getTrashDir,
} from './io.js';
import { clearURLCacheFor, clearPendingAll } from './image.js';
import { enqueue } from './writer.js';
import { toast, openModal, closeModal, confirmDialog } from './ui.js';
import { clearMDCache } from './md.js';
import {
  findNode, findParent, walk, pathOf, pOf, isDesc, subtreeIds,
} from './tree-utils.js';
import { renderTree } from './tree-render.js';

/* ---------- 依赖注入 ---------- */
let D = {
  renderAll: () => {},
  savePrefs: () => {},
};
export function wireTreeOps(h) { Object.assign(D, h); }

/* ============================================================
 * 新增
 * ============================================================ */

export function addNode(parentId, title) {
  const p = findNode(parentId); if (!p) return null;
  const n = { id: uid(), title, entries: [], children: [], _pending: true };
  p.children.push(n); Store.rebuildIndex();
  if (parentId !== '__root__') Store.collapsed.delete(pOf(p));

  enqueue(async () => {
    let ok = false;
    try {
      const pdir = dirOf(p);
      n._name = await uniqueName(pdir, sanitizeName(title));
      n._dir  = await Storage.getDir(pdir, n._name, { create: true });
      await writeEntriesFile(n);
      await writeOrder(p);
      const meta = { createdAt: fmtStamp(Date.now()) };
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
  const oldSelf = pOf(n);
  const prefix = oldSelf + '\u0001';
  for (const k of [...Store.collapsed]) {
    if (k === oldSelf || k.startsWith(prefix)) {
      Store.collapsed.delete(k);
    }
  }
  n.title = title;
  clearMDCache();
  enqueue(async () => {
    const pdir = dirOf(p);
    const base = sanitizeName(title);
    let dirChanged = false;
    try {
      if (base !== n._name) {
        const newName = await uniqueName(pdir, base);
        const nd = await moveDir(n._dir, pdir, newName);
        dirChanged = true;
        try { await Storage.removeEntry(pdir, n._name, { recursive: true }); }
        catch (e) { console.warn('[rename] 删旧目录失败（可忽略）:', e); }
        n._dir = nd; n._name = newName;
        await refreshHandles(n);
        clearURLCacheFor(n.id);
      }
      await writeEntriesFile(n);
      await writeOrder(p);
    } catch (e) {
      if (!dirChanged) {
        n.title = oldTitle;
        D.renderAll();
      }
      throw e;
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
        await refreshHandles(n);
        clearURLCacheFor(n.id);
      }
      await writeOrder(oldP);
      if (newP !== oldP) await writeOrder(newP);
    } catch (e) {
      if (!dirMoved) rollbackMem();
      throw e;
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
  const collect = n => {
    Store.scrollMemo.delete(n.id);
    for (const c of n.children) collect(c);
  };
  collect(n);
  Store.rebuildIndex();

  const restoreMem = () => {
    p.children.splice(savedIndex, 0, n);
    Store.rebuildIndex();
    D.renderAll();
  };

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
    const moved = await moveDir(n._dir, trashDir, tname);

    const meta = {
      deletedAt: fmtStamp(Date.now()),
      parentPath: pathOf(p).map(x => x.title).join('/'),
      parentId: p.id === '__root__' ? null : (p.topicId || null),
      originalName: n._name,
      originalId: n.topicId || null,
    };
    try {
      await atomicWriteText(moved, '_回收信息.json', JSON.stringify(meta, null, 2));
    } catch (e) {
      console.warn('[deleteNode] 写回收信息失败（可忽略）:', e);
    }

    try {
      const pdir = dirOf(p);
      await Storage.removeEntry(pdir, n._name, { recursive: true });
    } catch (e) {
      console.warn('[deleteNode] 删原目录失败（可忽略）:', e);
    }

    await writeOrder(p);
  });

  /* 失败细节（toast / 红灯 / 权限恢复）由 writer 统一处置，
     这里只负责把内存恢复回去 */
  if (!r.ok) {
    restoreMem();
    return false;
  }

  toast('已删除「' + n.title + '」');
  clearPendingAll();
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

    if (wasSelected) {
      Store.ui.selectedId = (p.id !== '__root__'
        ? p.id
        : (Store.root.children[0] ? Store.root.children[0].id : null));
      Store.ui.editingEntry = null;
    }
    D.renderAll();
  });
}