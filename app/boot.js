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
import { Store, draftTopicIds } from './store.js';
import { Storage } from './storage.js';
import { PLATFORM, invoke } from './platform.js';
import { installMathOverflowWatcher } from './md.js';
import { findNode, findByPath, pOf, stats, collapseAll } from './tree-utils.js';
import { recoverTempFiles } from './writeSecurity.js';
import { scanChildren } from './loader.js';
import { setStatus, markFsReady, enqueue } from './writer.js';
import { clearRuntimeCaches } from './cacheClear.js';
import { resetMeta } from './meta-row.js';
import { select } from './tree.js';
import { setDialogueEnabled } from './entries-render.js';
import { initTheme, theme } from './theme.js';
import { toast, confirmDialog } from './ui.js';
import { pickDirectory } from './picker.js';

const ANDROID_ROOT = '/storage/emulated/0';

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
/* 实现在 tree-utils.js（loader 重扫也要用，避免 boot ↔ loader 循环 import） */

/* ---------- 启动页 ---------- */

const gate = $('#gate');
function hideGate() { gate.classList.add('hidden'); }

/* ---------- 连接 ---------- */

/* 连接 / 重扫是同步读盘 + 解析，大目录要几秒：给一个覆盖层，别让用户以为卡死 */
let bootMask = null;
export async function withBusy(label, fn) {
  if (!bootMask) {
    bootMask = document.createElement('div');
    bootMask.id = 'bootMask';
    bootMask.innerHTML =
      '<div class="bm-card"><div class="bm-spin"></div><div class="bm-text"></div></div>';
    document.body.appendChild(bootMask);
    requestAnimationFrame(() => { if (bootMask) bootMask.classList.add('on'); });
  }
  const txt = bootMask.querySelector('.bm-text');
  if (txt) txt.textContent = label || '正在读取…';
  try {
    return await fn();
  } finally {
    const el = bootMask;
    bootMask = null;
    if (el) {
      el.classList.remove('on');
      setTimeout(() => el.remove(), 260);
    }
  }
}

export async function connect(h) {
  const label = '正在读取：' + (String(h && h.name ? h.name : h).split(/[\\\/]/).filter(Boolean).pop() || '');
  await withBusy(label, () => connectInner(h));
}

async function connectInner(h) {
  /* ── Tauri 分支：h 是路径字符串 ── */
  if (PLATFORM.isTauri) {
    Store.setDir(h);
    try { localStorage.setItem('shizhijian.dir', h); } catch (e) {}

    Store.root.children = await scanChildren(h);
    Store.rebuildIndex();
    clearRuntimeCaches();
    resetMeta();

    Store.resetViewState();
    history.replaceState({ root: true }, '');

    Store.collapsed.clear();
    collapseAll();

    Store.fs.ready = true;
    Store.fs.hasError = false;
    markFsReady();
    $('#saveDot').title = '';
    const fn = $('#folderName');
    if (fn) fn.textContent = h.split(/[\\\/]/).filter(Boolean).pop() || h;

    await initTheme();
    setDialogueEnabled(theme.dialogue);
    hideGate();
    D.renderAll();
    setStatus('saved', stats());

    const prefs = loadPrefs();
    const t = prefs.sel ? findByPath(prefs.sel) : null;
    const initial = t || Store.root.children[0];
    if (initial) select(initial.id);
    return;
  }
  //web版
  await recoverTempFiles(h);
  Store.setDir(h);
  try { await idbSet('dir', h); } catch (e) {}
  Store.root.children = await scanChildren(h);
  Store.rebuildIndex();
  clearRuntimeCaches();
  resetMeta();

  Store.resetViewState();
  history.replaceState({ root: true }, '');

  const prefs = loadPrefs();
  Store.collapsed.clear();
  collapseAll();

  Store.fs.ready = true;
  Store.fs.hasError = false;
  markFsReady();          /* 放行"未连接期"排队等着的写任务 */
  $('#saveDot').title = '';
  const fnW = $('#folderName');
  if (fnW) fnW.textContent = h.name;
  await initTheme();
  setDialogueEnabled(theme.dialogue);
  hideGate();
  D.renderAll();
  setStatus('saved', stats());

  const t = prefs.sel ? findByPath(prefs.sel) : null;
  const initial = t || Store.root.children[0];
  if (initial) select(initial.id);
}

/* Google Play 要求「所有文件访问」有正当理由、审核严格；本项目是自用/侧载，
   所以直接用它换取「路径语义不变」——上层 io / writer / loader 一行不用改。 */

/* 新目录是空的、而应用私有目录里还有旧数据时，问一句要不要搬过去 */
async function maybeMigrateFromAppDir(dir) {
  let items = [];
  try { items = await Storage.listEntries(dir); } catch (e) { return; }
  if (items.length) return;
  let oldDir = null;
  try { oldDir = await Storage.defaultDir(); } catch (e) { return; }
  if (!oldDir || oldDir === dir) return;
  let oldItems = [];
  try { oldItems = await Storage.listEntries(oldDir); } catch (e) { return; }
  if (!oldItems.length) return;
  const ok = await confirmDialog(
    '把旧记录搬过来？',
    '应用私有目录里还有 ' + oldItems.length + ' 个条目。\n' +
    '要把它们复制到新文件夹吗？（只复制，不删原件）',
    { okText: '复制过来' }
  );
  if (!ok) return;
  try {
    const n = await Storage.copyDirTree(oldDir, dir);
    toast('已复制 ' + n + ' 个文件');
  } catch (e) {
    toast('复制失败：' + ((e && e.message) || e));
  }
}

/**
 * Android：先确认「所有文件访问」权限，再打开应用内目录浏览器。
 * 返回选中的路径；取消 / 没权限 / 系统太老 都返回 null。
 * （桌面和 Web 走系统自带的文件夹对话框，用不到这个。）
 */
export async function chooseAndroidDir() {
  const sdk = Storage.androidSdk();
  if (sdk && sdk < 30) {
    toast('Android 10 及以下只能用应用私有目录');
    return null;
  }
  if (!(await Storage.canWriteDir(ANDROID_ROOT))) {
    const go = await confirmDialog(
      '需要「所有文件访问」权限',
      '要自己挑存储文件夹，Android 11+ 需要这个权限。\n' +
      '点「去授权」→ 在系统设置里打开这项权限 → 回来再点一次按钮。',
      { okText: '去授权' }
    );
    if (go && !Storage.requestAllFilesAccess()) {
      toast('请到「设置 → 应用 → 时枝笺 → 权限」里打开「所有文件访问」');
    }
    return null;
  }
  const dir = await pickDirectory({ start: ANDROID_ROOT, title: '选择存储文件夹' });
  if (!dir) return null;
  await maybeMigrateFromAppDir(dir);
  return dir;
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
  /* ── Tauri 分支 ── */
  if (PLATFORM.isTauri) {
    let dir;
    try {
      /* Android 没有系统文件夹选择器 → 应用内目录浏览器（见 chooseAndroidDir） */
      if (PLATFORM.isAndroid) {
        dir = await chooseAndroidDir();
      } else {
        dir = await invoke('plugin:dialog|open', {
          options: { directory: true, multiple: false, title: '选择存储文件夹' },
        });
      }
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('无法打开文件夹：' + (e.message || e));
      return;
    }
    if (!dir) return;
    await connect(dir);
    return;
  }

  /* ── Web 分支（原逻辑）── */
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
  /* 桌面版记住的是路径（不是浏览器里的目录句柄） */
  if (PLATFORM.isTauri) {
    const dir = this._path;
    if (!dir) return;
    connect(dir).catch(e => toast('连接失败：' + (e.message || e)));
    return;
  }
  if (this._h) requestConnect(this._h);
});

/* ---------- 启动入口 ---------- */

export async function boot() {
  console.log('### boot.js', new Date().toLocaleTimeString(), '###');
  installMathOverflowWatcher();
  history.replaceState({ root: true }, '');

  /* ── Tauri 分支：从 localStorage 读上次路径 ──
     有记录也只显示「继续使用」按钮，不自动进入 —— 由用户决定这次用哪个文件夹。 */
  if (PLATFORM.isTauri) {
    let dir = null;
    try { dir = localStorage.getItem('shizhijian.dir'); } catch (e) {}
    if (dir) {
      const btn = $('#gateReconnect');
      if (btn) {
        btn.classList.remove('hidden');
        btn._path = dir;
        const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
        btn.innerHTML = I.folder + '<span>继续使用「' + esc(name) + '」</span>';
      }
    }
    return;
  }

  /* ── Web 分支：原逻辑 ── */
  let h = null;
  try { h = await idbGet('dir'); } catch (e) {}

  if (h && h.name) {
    /* 不因为浏览器已授权就直接进入：仍然停在启动页，让用户点「继续使用」。 */
    const btn = $('#gateReconnect');
    btn.classList.remove('hidden');
    btn._h = h;
    btn.innerHTML = I.folder + '<span>继续使用「' + esc(h.name) + '」</span>';
  }
}
/* ---------- 更换存储文件夹 ----------
 * 桌面 / Web：系统选择器；Android：应用内目录浏览器（系统没有选目录对话框）。
 * 所有确认（排队写入 / 未发送草稿）都在这里，app.js 只负责把它接给按钮。
 */
export async function changeFolder() {
  let dir = null;

  if (PLATFORM.isTauri) {
    try {
      if (PLATFORM.isAndroid) {
        dir = await chooseAndroidDir();
        if (!dir) return;
        if (Store.dir === dir) { toast('已经是这个文件夹了：' + dir); return; }
      } else {
        dir = await invoke('plugin:dialog|open', {
          options: { directory: true, multiple: false, title: '选择存储文件夹' },
        });
      }
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('无法打开文件夹：' + (e.message || e));
      return;
    }
    if (!dir) return;
  } else {
    const opts = { mode: 'readwrite' };
    if (Store.dir) opts.startIn = Store.dir;
    try {
      dir = await window.showDirectoryPicker(opts);
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('无法打开文件夹：' + (e.message || e));
      return;
    }
    if (!dir) return;
  }

  if (Store.fs.pending > 0) {
    const ok = await confirmDialog(
      '还有写入未完成',
      '当前有 ' + Store.fs.pending + ' 个磁盘写入任务在排队。\n' +
      '现在切换文件夹会中断它们。',
      { danger: true, okText: '仍然切换' }
    );
    if (!ok) return;
  }

  const drafts = draftTopicIds();
  if (drafts.length) {
    const first = findNode(drafts[0]);
    const name = first ? first.title : '（已删除的话题）';
    const go = await confirmDialog(
      '有未发送的草稿',
      '有 ' + drafts.length + ' 个话题里存在未发送的草稿，最早的一个是「' + name + '」。\n' +
      '切换文件夹会丢弃这些草稿。要先去处理吗？',
      { okText: '去看看', cancelText: '仍然切换' }
    );
    if (go) { select(drafts[0]); return; }
  }

  enqueue(async () => { await connect(dir); });
}
