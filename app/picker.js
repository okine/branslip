// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Okine
// 时枝笺 · BRANSLIP —— 见根目录 LICENSE

'use strict';
/* ================= picker.js =================
 * 应用内「选文件夹」对话框。
 *
 * 为什么需要它：Android 没有系统级文件夹选择器
 * （tauri-plugin-dialog 只发 ACTION_GET_CONTENT / ACTION_CREATE_DOCUMENT，
 *   没有 ACTION_OPEN_DOCUMENT_TREE），所以自己用已有的 Storage.listEntries
 * 做一个目录浏览器。拿到「所有文件访问」权限后，选中路径就能直接当 dir 用，
 * 上层的 io / writer / loader 一行都不用改。
 *
 * 只依赖 Storage / ui，不碰 Store。
 *
 *   pickDirectory({ start, title }) → Promise<string|null>
 */

import { esc } from './utils.js';
import { Storage } from './storage.js';
import { openModal, closeModal, toast } from './ui.js';

const ANDROID_ROOT = '/storage/emulated/0';

function joinPath(dir, name) {
  return String(dir).replace(/[\\/]+$/, '') + '/' + name;
}
function parentOf(dir) {
  const s = String(dir).replace(/[\\/]+$/, '');
  if (!s || s === ANDROID_ROOT) return ANDROID_ROOT;
  const i = s.lastIndexOf('/');
  if (i <= 0) return '/';
  const p = s.slice(0, i);
  return p === '' ? '/' : p;
}

export function pickDirectory(opts) {
  const start = (opts && opts.start) || ANDROID_ROOT;
  const title = (opts && opts.title) || '选择存储文件夹';

  return new Promise(resolve => {
    let cur = start;
    let done = false;

    const md = openModal(
      '<h3>' + esc(title) + '</h3>' +
      '<p class="sub pk-path" data-pk-path></p>' +
      '<div class="pk-chips">' +
        '<button class="pk-chip" data-pk-go="' + ANDROID_ROOT + '">内部存储</button>' +
        '<button class="pk-chip" data-pk-go="' + ANDROID_ROOT + '/Documents">Documents</button>' +
        '<button class="pk-chip" data-pk-go="' + ANDROID_ROOT + '/Download">Download</button>' +
        '<button class="pk-chip" data-pk-new="1">新建「时枝笺」到这里</button>' +
      '</div>' +
      '<div class="pk-list" data-pk-list></div>' +
      '<div class="modal-btns">' +
        '<button class="m-btn" data-pk-up>上一级</button>' +
        '<button class="m-btn" data-pk-cancel>取消</button>' +
        '<button class="m-btn" data-pk-ok style="background:var(--accent);color:#F5F1E4">用这个文件夹</button>' +
      '</div>',
      () => { if (!done) { done = true; resolve(null); } }
    );

    const pathEl = md.querySelector('[data-pk-path]');
    const listEl = md.querySelector('[data-pk-list]');

    async function render() {
      pathEl.textContent = cur;
      pathEl.title = cur;
      listEl.innerHTML = '<div class="pk-empty">读取中…</div>';
      let items = [];
      try {
        items = await Storage.listEntries(cur);
      } catch (e) {
        listEl.innerHTML = '<div class="pk-empty">读不了这个目录：' +
          esc((e && e.message) || e) + '</div>';
        return;
      }
      const dirs = items
        .filter(it => it.kind === 'directory' || it.kind === 'dir')
        .map(it => it.name)
        .filter(n => n && !n.startsWith('.'))
        .sort((a, b) => a.localeCompare(b, 'zh'));
      listEl.innerHTML = dirs.length
        ? dirs.map(n =>
            '<button class="pk-row" data-pk-enter="' + esc(n) + '">' +
              '<span class="pk-folder">📁</span><span class="pk-name">' + esc(n) + '</span>' +
            '</button>'
          ).join('')
        : '<div class="pk-empty">（这个文件夹里没有子文件夹）</div>';
    }

    async function pick(dir) {
      if (!(await Storage.canWriteDir(dir))) {
        toast('这个文件夹写不进去：可能没有「所有文件访问」权限，或位置只读');
        return;
      }
      done = true;
      closeModal();
      resolve(dir);
    }

    md.addEventListener('click', async e => {
      const t = e.target;
      const enter = t.closest('[data-pk-enter]');
      if (enter) { cur = joinPath(cur, enter.dataset.pkEnter); render(); return; }

      const go = t.closest('[data-pk-go]');
      if (go) { cur = go.dataset.pkGo; render(); return; }

      if (t.closest('[data-pk-up]')) { cur = parentOf(cur); render(); return; }
      if (t.closest('[data-pk-cancel]')) { done = true; closeModal(); resolve(null); return; }
      if (t.closest('[data-pk-ok]')) { pick(cur); return; }

      if (t.closest('[data-pk-new]')) {
        /* 在当前位置建一个「时枝笺」并选中它 —— 省得用户先去找文件管理器 */
        const dest = joinPath(cur, '时枝笺');
        try {
          await Storage.getDir(cur, '时枝笺', { create: true });
        } catch (err) {
          toast('新建失败：' + ((err && err.message) || err));
          return;
        }
        pick(dest);
      }
    });

    render();
  });
}
