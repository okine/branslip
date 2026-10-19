'use strict';
/* ================= fixed-buttons.js =================
 * 固定按钮（左侧工具栏 + 顶栏详情）的排版、注入与事件。
 *
 * 原则：
 *   - 叶子动作（拾之 / 合并 / 回收站 / 主题 / 导出）直接 import；
 *   - 需要 app 编排的动作（重扫 / 换文件夹）通过 init 参数注入；
 *   - 导入流程在这里拥有 picker，renderAll/select 由 app 注入。
 *
 * 对外：
 *   initFixedButtons({ renderAll, select, onRescan, onChangeFolder })
 *   syncFixedButtons()
 */

import { Store } from './store.js';
import { I } from './icons.js';
import { toast } from './ui.js';
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

/* 只改这个数组的顺序就能调整固定按钮位置 */
const FIXED_BUTTONS = [
  { id: 'tbPickIt', icon: 'sparkles', label: '拾之', title: '随机抽几条旧记录看看', onClick: pickItPage },
  { id: 'tbMerge',  icon: 'layers',   label: '合并', title: '时间流 / 合并多个话题', onClick: btn => openMergeMenu(btn) },
  { id: 'tbTrash',  icon: 'trash',    label: '回收站', title: '回收站', onClick: openTrashPage },
  { sep: true },
  {
    id: 'importBtn', icon: 'import', label: '导入', title: '导入对话（.json）',
    onClick: () => {
      if (!Store.fs.ready) { toast('尚未连接文件夹'); return; }
      importPick?.click();
    },
  },
  { id: 'rescanBtn', icon: 'refresh', label: '重扫', title: '从磁盘重新读取（在外部改过文件后点这个）', onClick: () => PORTS.onRescan?.() },
  { id: 'folderBtn', icon: 'folder', label: '未连接', labelId: 'folderName', title: '更改存储文件夹', onClick: () => PORTS.onChangeFolder?.() },
  { id: 'tbTheme', icon: 'palette', label: '主题', title: '主题与背景', onClick: openThemePanel },
  { id: 'tbExport', icon: 'folder', label: '导出', title: '导出为 ZIP 压缩包', onClick: exportZipFlow },
];

export function initFixedButtons(ports) {
  PORTS = ports || {};

  const tb = document.getElementById('toolbar');
  if (!tb) return;

  tb.innerHTML = FIXED_BUTTONS.map(it => {
    if (it.sep) return '<div class="tb-sep"></div>';
    return '<button type="button" class="tb-btn" id="' + it.id + '" title="' + it.title + '">' +
      '<span class="tb-ic">' + (I[it.icon] || '') + '</span>' +
      '<span class="tb-label"' + (it.labelId ? ' id="' + it.labelId + '"' : '') + '>' +
        it.label +
      '</span>' +
    '</button>';
  }).join('');

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
