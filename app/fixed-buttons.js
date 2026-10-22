'use strict';
/* ================= fixed-buttons.js =================
 * 固定按钮（左侧工具栏 + 顶栏详情）的排版、注入与事件。
 *
 * 布局（三端统一）：
 *   主键四个：拾之 / 合并 / 导入 / 更多
 *   「更多」菜单里：回收站 / 重扫 / 存储文件夹 / 主题 / 导出 / 清理缓存
 *   窄屏（≤860px）时整条工具栏搬进侧栏抽屉，按钮显示文字。
 *
 * 对外：
 *   initFixedButtons({ renderAll, select, onRescan, onChangeFolder })
 *   syncFixedButtons()
 */

import { Store } from './store.js';
import { I } from './icons.js';
import { $ } from './utils.js';
import { toast, confirmDialog, openMenu, toggleMenu } from './ui.js';
import { clearRuntimeCaches } from './cacheClear.js';
import { flushAllScroll } from './entries-jump.js';
import { waitForIdle } from './writer.js';
import { pickItPage } from './pages.js';
import { openMergeMenu } from './entries-merge.js';
import { openTrashPage } from './trash.js';
import { openTopicDetails } from './topic-info.js';
import { openThemePanel } from './theme.js';
import { exportZipFlow } from './zip.js';
import { initImportPicker, runImportFile } from './import-runtime.js';
import { parseDeepSeekExport, importDeepSeekAsTopics } from './import-deepseek.js';
import { parseClaudeExport, importClaudeAsTopics } from './import-claude.js';
import { parseQwenExport, importQwenAsTopics } from './import-qwen.js';
import { parseTelegramExport, importTelegramAsTopics } from './import-telegram.js';
import { parseQQExport, importQQAsTopics } from './import-qq.js';

const IMPORT_ATTEMPTS = [
  ['deepseek', parseDeepSeekExport, importDeepSeekAsTopics],
  ['claude',   parseClaudeExport,   importClaudeAsTopics],
  ['qwen',     parseQwenExport,     importQwenAsTopics],
  ['telegram', parseTelegramExport, importTelegramAsTopics],
  ['qq',       parseQQExport,       importQQAsTopics],
];

let PORTS = {};
let importPick = null;

/* 主键 —— 只改这个数组的顺序就能调整固定按钮位置 */
const FIXED_BUTTONS = [
  { id: 'tbPickIt', icon: 'sparkles', label: '拾之', title: '随机抽几条旧记录看看', onClick: pickItPage },
  { id: 'tbMerge',  icon: 'layers',   label: '合并', title: '时间流 / 合并多个话题', onClick: btn => openMergeMenu(btn) },
  {
    id: 'importBtn', icon: 'import', label: '导入', title: '导入对话（.json）',
    onClick: () => {
      if (!Store.fs.ready) { toast('尚未连接文件夹'); return; }
      importPick?.click();
    },
  },
  { id: 'tbMore', icon: 'info', label: '更多', title: '回收站 / 重扫 / 文件夹 / 主题 / 导出 / 清缓存', onClick: btn => openMoreMenu(btn) },
];

/* 清理缓存：菜单项和「更多」共用 */
async function clearCacheFlow() {
  const ok = await confirmDialog('清理缓存？', '部分内容需要重新加载。', { okText: '清理' });
  if (!ok) return;
  /* 滚动位置属于磁盘状态（_话题.json 的 scroll），不能跟内存缓存一起丢：
     先 flush 再等写盘队列落地，最后才清缓存。 */
  try {
    flushAllScroll();
    await waitForIdle();
  } catch (e) {}
  clearRuntimeCaches();
  toast('缓存已清理，正在重新加载');
  PORTS.renderAll?.();
}

/* 「更多」菜单：每次点都重新取文件夹名，保持是最新的 */
function openMoreMenu(anchor) {
  /* 再点一次「更多」→ 收起 */
  if (toggleMenu(anchor)) return;
  const fnEl = $('#folderName');
  const folderName = (fnEl && fnEl.textContent) || '未连接';
  openMenu(anchor, [
    { icon: I.trash,   label: '回收站', fn: openTrashPage },
    { icon: I.refresh, label: '重扫（从磁盘重新读）', fn: () => PORTS.onRescan?.() },
    { icon: I.folder,  label: '存储文件夹：' + folderName, fn: () => PORTS.onChangeFolder?.() },
    { sep: true },
    { icon: I.palette, label: '主题与背景', fn: () => openThemePanel(anchor) },
    { icon: I.folder,  label: '导出 ZIP', fn: () => exportZipFlow(anchor) },
    { icon: I.broom,   label: '清理缓存', fn: clearCacheFlow },
  ]);
}

export function initFixedButtons(ports) {
  PORTS = ports || {};

  const tb = document.getElementById('toolbar');
  if (!tb) return;

  /* 构建标记：控制台看一眼就知道跑的是不是新包 */
  window.__SH_BUILD = '2026-10-22 20:10 · toolbar 4+more';
  console.log('[时枝笺]', window.__SH_BUILD);

  tb.innerHTML = FIXED_BUTTONS.map(it =>
    '<button type="button" class="tb-btn" id="' + it.id + '" title="' + it.title + '">' +
      '<span class="tb-ic">' + (I[it.icon] || '') + '</span>' +
      '<span class="tb-label"' + (it.labelId ? ' id="' + it.labelId + '"' : '') + '>' +
        it.label +
      '</span>' +
    '</button>'
  ).join('') +
    /* 保留一个隐藏的 #folderName：boot.js 连上目录后会往里写名字，
       「更多」菜单读它来显示当前文件夹。 */
    '<span id="folderName" class="sr-only"></span>';

  for (const it of FIXED_BUTTONS) {
    if (!it.id || typeof it.onClick !== 'function') continue;
    const btn = document.getElementById(it.id);
    if (btn) btn.addEventListener('click', () => it.onClick(btn));
  }

  importPick = initImportPicker();
  importPick.addEventListener('change', () => {
    const f = importPick.files[0];
    importPick.value = '';
    if (f) runImportFile(f, {
      attempts: IMPORT_ATTEMPTS,
      renderAll: PORTS.renderAll,
      select: PORTS.select,
    });
  });

  const detail = document.getElementById('detailBtn');
  if (detail) {
    detail.innerHTML = I.info + '<span>详情</span>';
    detail.addEventListener('click', () => {
      openTopicDetails(Store.node(Store.ui.selectedId));
    });
  }

  /* 窄屏（手机）：整条工具栏搬进侧栏抽屉，按钮显示文字；宽屏搬回左侧竖排。 */
  const mq = window.matchMedia('(max-width: 860px)');
  const placeToolbar = () => {
    const app  = document.getElementById('app');
    const host = document.getElementById('sideTools');
    const tbEl = document.getElementById('toolbar');
    if (!app || !host || !tbEl) return;
    if (mq.matches) {
      if (tbEl.parentElement !== host) host.appendChild(tbEl);
    } else if (tbEl.parentElement !== app) {
      app.insertBefore(tbEl, document.getElementById('sidebar'));
    }
  };
  placeToolbar();
  if (mq.addEventListener) mq.addEventListener('change', placeToolbar);
  else if (mq.addListener) mq.addListener(placeToolbar);

  /* 抽屉里点工具：默认收起抽屉；但「合并」「更多」要在抽屉里继续操作，不收。
     合并菜单开着时，其它键一律不响应（防误触）。 */
  const tbHost = document.getElementById('toolbar');
  if (tbHost) {
    tbHost.addEventListener('click', e => {
      if (!mq.matches) return;
      const btn = e.target.closest('.tb-btn');
      if (!btn) return;
      if (btn.id === 'tbMerge' || btn.id === 'tbMore') return;
      if (document.querySelector('#menuRoot .menu')) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      setTimeout(() => document.body.classList.remove('side-open'), 0);
    }, true);
  }

  syncFixedButtons();
}

export function syncFixedButtons() {
  const merge = document.getElementById('tbMerge');
  if (merge) merge.classList.toggle('on', !!Store.ui.merged);

  const detail = document.getElementById('detailBtn');
  if (detail) {
    const n = Store.node(Store.ui.selectedId);
    const has = !!n && !n._pending;
    detail.disabled = !has;
    detail.title = has ? '话题详情：简介、记录/图片数量与缩略图' : '先选择一个话题';
  }
}
