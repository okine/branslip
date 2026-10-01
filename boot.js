// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE

'use strict';
/* ================= boot.js =================
 * 启动流程：IndexedDB 句柄持久化 / 偏好读写 / 连接 / gate 交互。
 *
 * 对外：
 *   boot()                                入口，index.html 调
 *   wireBoot({ renderAll })               注入主区渲染
 *   loadPrefs / savePrefs / collapseAll   供 app.js 的 rescan / wireTree 使用
 *   connect / idbGet / idbSet             兜底导出
 */


import { $, esc } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { installMathOverflowWatcher } from './md.js';
import { findNode, findByPath, pOf, stats } from './tree-utils.js';
import { recoverTempFiles } from './io.js';
import { scanChildren } from './loader.js';
import { initZipButton } from './zip.js';
import { setStatus, markFsReady } from './writer.js';
import { select } from './tree.js';
import { setDialogueEnabled } from './entries.js';
import { clearURLCache, clearPendingForNode } from './image.js';
import { initTheme, theme } from './theme.js';
import { toast } from './ui.js';

/* ---------- 依赖注入 ---------- */
let D = { renderAll: () => {} };
export function wireBoot(h) { Object.assign(D, h); }

/* ---------- IndexedDB ---------- */

function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open('shizhijian-fs', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
export async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(k);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

/* ---------- 偏好（localStorage） ---------- */

const PREF_KEY = 'shizhijian.fs.v1';

export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; }
  catch (e) { return {}; }
}

let prefTimer = null;
export function savePrefs() {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        sel: Store.ui.selectedId ? pOf(findNode(Store.ui.selectedId)) : null,
      }));
    } catch (e) {}
  }, 200);
}

/* ---------- 折叠全部 ---------- */

export function collapseAll() {
  const rec = (node, parentKey) => {
    for (const c of node.children) {
      const key = parentKey ? parentKey + '\u0001' + c.title : c.title;
      if (c.children.length) Store.collapsed.add(key);
      rec(c, key);
    }
  };
  rec(Store.root, '');
}

/* ---------- 启动页 ---------- */

const gate = $('#gate');
function hideGate() { gate.classList.add('hidden'); }

/* ---------- 连接 ---------- */

export async function connect(h) {
  await recoverTempFiles(h);
  Store.setDir(h);
  try { await idbSet('dir', h); } catch (e) {}
  Store.root.children = await scanChildren(h);
  Store.rebuildIndex();
  clearURLCache();
  Store.resetMetaBuilt();

  Store.ui.viewHistory = [];
  Store.ui.drafts.clear();
  for (const n of Store.nodes()) {
    if (n.id !== '__root__') clearPendingForNode(n.id);
  }
  Store.ui.viewCursor = -1;
  history.replaceState({ root: true }, '');

  const prefs = loadPrefs();
  Store.collapsed.clear();
  collapseAll();

  Store.fs.ready = true;
  Store.fs.hasError = false;
  markFsReady();          /* 放行"未连接期"排队等着的写任务 */
  $('#saveDot').title = '';
  $('#folderName').textContent = h.name;
  await initTheme();
  setDialogueEnabled(theme.dialogue);
  hideGate();
  D.renderAll();
  setStatus('saved', stats());

  const t = prefs.sel ? findByPath(prefs.sel) : null;
  const initial = t || Store.root.children[0];
  if (initial) select(initial.id);
}

async function requestConnect(h) {
  try {
    const perm = await h.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') { await connect(h); return; }
    toast('未获得文件夹读写权限');
  } catch (e) {
    toast('连接失败：' + (e.message || e));
  }
}

$('#gatePick').addEventListener('click', async () => {
  const opts = { mode: 'readwrite' };
  if (Store.dir) opts.startIn = Store.dir;
  else {
    try {
      const last = await idbGet('dir');
      if (last) opts.startIn = last;
    } catch (e) {}
  }

  let h;
  try {
    h = await window.showDirectoryPicker(opts);
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('无法打开文件夹：' + (e.message || e));
    return;
  }
  await connect(h);
});

$('#gateReconnect').addEventListener('click', function () {
  if (this._h) requestConnect(this._h);
});

/* ---------- 启动入口 ---------- */

export async function boot() {
  console.log('### boot.js', new Date().toLocaleTimeString(), '###');
  installMathOverflowWatcher();
  initZipButton();
  history.replaceState({ root: true }, '');

  let h = null;
  try { h = await idbGet('dir'); } catch (e) {}

  if (h && h.name) {
    let perm = 'prompt';
    try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) {}

    if (perm === 'granted') {
      try { await connect(h); return; }
      catch (e) { toast('连接上次文件夹失败：' + (e.message || e)); }
    }

    const btn = $('#gateReconnect');
    btn.classList.remove('hidden');
    btn._h = h;
    btn.innerHTML = I.folder + '<span>继续使用「' + esc(h.name) + '」</span>';
  }
}