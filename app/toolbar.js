'use strict';
/* ================= toolbar.js =================
 * 左侧工具栏 + 顶栏“详情”按钮的排版与事件。
 *
 * 这里只负责“按钮长在哪、点了打开谁”，具体页面仍在
 * pages.js / entries-merge.js / trash.js / topic-info.js。
 *
 * 对外：
 *   initToolbar()  启动时构建按钮（app.js 调用一次）
 *   syncToolbar()  根据 selectedId / merged 状态同步 active / disabled
 */

import { Store } from './store.js';
import { I } from './icons.js';
import { pickItPage } from './pages.js';
import { openMergeMenu } from './entries-merge.js';
import { openTrashPage } from './trash.js';
import { openTopicDetails } from './topic-info.js';
import { openThemePanel } from './theme.js';
import { exportZipFlow } from './zip.js';

/* 工具栏按钮表 —— 只改这个数组的顺序就能调整左侧按钮位置。
 * 没有 onClick 的项（importBtn / rescanBtn / folderBtn）由 app.js 绑定，
 * 因为它们的流程依赖导入/重扫/换文件夹的上下文。 */
const SIDE_BUTTONS = [
  { id: 'tbPickIt', icon: 'sparkles', label: '拾之', title: '随机抽几条旧记录看看', onClick: pickItPage },
  { id: 'tbMerge',  icon: 'layers',   label: '合并', title: '时间流 / 合并多个话题', onClick: btn => openMergeMenu(btn) },
  { id: 'tbTrash',  icon: 'trash',    label: '回收站', title: '回收站', onClick: openTrashPage },
  { sep: true },
  { id: 'importBtn', icon: 'import', label: '导入', title: '导入对话（.json）' },
  { id: 'rescanBtn', icon: 'refresh', label: '重扫', title: '从磁盘重新读取（在外部改过文件后点这个）' },
  { id: 'folderBtn', icon: 'folder', label: '未连接', labelId: 'folderName', title: '更改存储文件夹' },
  { id: 'tbTheme', icon: 'palette', label: '主题', title: '主题与背景', onClick: openThemePanel },
  { id: 'tbExport', icon: 'folder', label: '导出', title: '导出为 ZIP 压缩包', onClick: exportZipFlow },
];

export function initToolbar() {
  const tb = document.getElementById('toolbar');
  if (!tb) return;

  tb.innerHTML = SIDE_BUTTONS.map(it => {
    if (it.sep) return '<div class="tb-sep"></div>';
    return '<button type="button" class="tb-btn" id="' + it.id + '" title="' + it.title + '">' +
      '<span class="tb-ic">' + (I[it.icon] || '') + '</span>' +
      '<span class="tb-label"' + (it.labelId ? ' id="' + it.labelId + '"' : '') + '>' +
        it.label +
      '</span>' +
    '</button>';
  }).join('');

  for (const it of SIDE_BUTTONS) {
    if (!it.id || typeof it.onClick !== 'function') continue;
    const btn = document.getElementById(it.id);
    if (btn) btn.addEventListener('click', () => it.onClick(btn));
  }

  const detail = document.getElementById('detailBtn');
  if (detail) {
    detail.innerHTML = I.info + '<span>详情</span>';
    detail.addEventListener('click', () => {
      openTopicDetails(Store.node(Store.ui.selectedId));
    });
  }

  syncToolbar();
}

export function syncToolbar() {
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
