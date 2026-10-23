'use strict';
/* ================= ui-topicPicker.js =================
 * 话题选择器：单选 / 多选（复选框）两个模式。
 *
 * 两种数据源：
 *   1. 默认：遍历当前话题树（Store.root），带折叠箭头；
 *   2. opts.items：外部给的扁平列表（导入时用 —— 这些话题还不在库里），
 *      可配 opts.search 搜索框，只按标题过滤。
 *
 * 从 ui.js 拆出，因为这里需要话题树语义（Store / pOf / badge），
 * 而 ui.js 只保留模态、菜单、toast 等基础原语。
 *
 * 对外：
 *   openTopicPicker(opts)   opts.mode = 'single' | 'multi'
 *   openMovePicker(...)     单选移动目标
 */

import { esc, badgeHTML, countLabel, filterTopicsByTitle } from './utils.js';
import { Store } from './store.js';
import { I } from './icons.js';
import { pOf } from './tree-utils.js';
import { openModal, closeModal, toast } from './ui.js';

/**
 * @param {object} opts
 *   mode          {'single'|'multi'}   默认 single
 *   title         {string}
 *   hint          {string}
 *   excludeIds    {string[]}           排除这些节点及其子树（树的模式）
 *   preselect     {string[]}           multi 初始勾选
 *   okText        {string}             multi 确认按钮文字
 *   emptyText     {string}             无可选话题时的提示
 *   items         {Array<{id,title,count?,subtitle?}>}  扁平列表（给了就不用树）
 *   search        {boolean}            显示"搜索话题名"输入框
 *   onPick        {(id) => void}       single：点一行时调用
 *   onPickMulti   {(ids) => void}      multi：确认时调用
 */
export function openTopicPicker(opts) {
  opts = opts || {};
  const isMulti = opts.mode === 'multi';
  const ex = new Set(opts.excludeIds || []);
  const selected = new Set(isMulti ? (opts.preselect || []) : []);
  /* 打开时同步主面板折叠状态；之后的折叠/展开只影响本次 picker */
  const collapsed = new Set(Store.collapsed);

  /* 扁平模式：外部列表 + 可选搜索 */
  const flat = Array.isArray(opts.items) ? opts.items.slice() : null;
  const total = flat ? flat.length : 0;
  let query = '';

  const title = opts.title || '选择话题';
  const hintHtml = opts.hint
    ? '<p class="sub">' + esc(opts.hint) + '</p>' : '';
  const okBtn = isMulti
    ? '<button class="m-btn" data-ok style="background:var(--accent);color:#F5F1E4">' +
      (opts.okText || '确认') + '</button>'
    : '';

  const searchHtml = (flat && opts.search)
    ? '<input class="picker-search" type="search" data-q ' +
      'placeholder="' + esc(opts.searchPlaceholder || '搜索话题名…') + '" ' +
      'autocomplete="off" spellcheck="false">'
    : '';
  const toolsHtml = (flat && isMulti)
    ? '<div class="picker-tools">' +
        '<button type="button" class="linkbtn" data-all>全选</button>' +
        '<button type="button" class="linkbtn" data-none>清空</button>' +
        '<span class="picker-count" data-count></span>' +
      '</div>'
    : '';

  const md = openModal(
    '<h3>' + esc(title) + '</h3>' + hintHtml + searchHtml + toolsHtml +
    '<div class="picker"></div>' +
    '<div class="modal-btns">' +
      '<button class="m-btn ghost" data-close>取消</button>' + okBtn +
    '</div>');

  const picker = md.querySelector('.picker');
  md.querySelector('[data-close]').addEventListener('click', closeModal);
  const okEl = md.querySelector('[data-ok]');
  const qEl = md.querySelector('[data-q]');
  const countEl = md.querySelector('[data-count]');

  function updateCount() {
    if (!countEl) return;
    countEl.textContent = '已选 ' + selected.size + ' / 共 ' + total;
  }

  function rowHtml(it, checked) {
    const cnt = it.subtitle
      ? '<span class="cnt">' + esc(it.subtitle) + '</span>'
      : '<span class="cnt">' + countLabel(it.count) + '</span>';
    const t = '<span class="pick-title">' + esc(it.title || '未命名') + '</span>';

    if (isMulti) {
      return '<label class="pick-row" style="--d:0">' +
        '<input type="checkbox" data-id="' + esc(String(it.id)) + '"' +
          (checked ? ' checked' : '') + '>' + t + cnt +
      '</label>';
    }
    return '<div class="pick-row" data-pick="' + esc(String(it.id)) + '" style="--d:0">' +
      t + cnt + '</div>';
  }

  /* —— 渲染：扁平列表 —— */
  function drawFlat() {
    const list = filterTopicsByTitle(flat, query);
    picker.innerHTML = list.length
      ? list.map(it => rowHtml(it, selected.has(String(it.id)))).join('')
      : '<div class="picker-empty">' +
          esc(query ? '没有匹配“' + query + '”的话题' : (opts.emptyText || '没有可选的话题')) +
        '</div>';
    updateCount();
  }

  /* —— 渲染：话题树 —— */
  function drawTree() {
    const prevTop = picker.scrollTop;
    let rows = '';

    (function rec(parent, depth, parentKey) {
      for (const c of parent.children) {
        if (ex.has(c.id)) continue;   // 排除 c 及其整棵子树

        /* 累积路径 key —— 和 tree.js 里 pOf(node) 完全同构 */
        const key = parentKey ? parentKey + '\u0001' + c.title : c.title;

        const hasKids = c.children.some(k => !ex.has(k.id));
        const isCollapsed = collapsed.has(key);
        const isChecked = selected.has(c.id);

        const chevHtml = hasKids
          ? '<button type="button" class="pick-chev' +
            (isCollapsed ? '' : ' open') +
            '" data-toggle="' + c.id + '" aria-label="展开/折叠">' +
            I.chev + '</button>'
          : '<span class="pick-chev-spacer"></span>';

        const badge = badgeHTML(c);
        const titleHtml = '<span class="pick-title">' + esc(c.title) + '</span>';
        const cnt = '<span class="cnt">' + countLabel(c.entries.length) + '</span>';

        if (isMulti) {
          rows += '<label class="pick-row" style="--d:' + depth + '">' +
            chevHtml +
            '<input type="checkbox" data-id="' + c.id + '"' +
              (isChecked ? ' checked' : '') + '>' +
            badge + titleHtml + cnt +
          '</label>';
        } else {
          rows += '<div class="pick-row" data-pick="' + c.id +
            '" style="--d:' + depth + '">' +
            chevHtml + badge + titleHtml + cnt +
          '</div>';
        }

        if (!isCollapsed) rec(c, depth + 1, key);
      }
    })(Store.root, 0, '');

    picker.innerHTML = rows ||
      '<div class="picker-empty">' +
        esc(opts.emptyText || '没有可选的目标话题') + '</div>';
    picker.scrollTop = prevTop;
  }

  const draw = flat ? drawFlat : drawTree;
  draw();

  /* —— 搜索（只过滤标题）—— */
  if (qEl) {
    qEl.addEventListener('input', () => {
      query = qEl.value;
      drawFlat();
    });
    setTimeout(() => { try { qEl.focus(); } catch (e) {} }, 0);
  }

  /* —— 全选 / 清空（只作用于当前过滤结果）—— */
  const allEl = md.querySelector('[data-all]');
  const noneEl = md.querySelector('[data-none]');
  if (allEl) {
    allEl.addEventListener('click', () => {
      for (const it of filterTopicsByTitle(flat, query)) selected.add(String(it.id));
      drawFlat();
    });
  }
  if (noneEl) {
    noneEl.addEventListener('click', () => {
      selected.clear();
      drawFlat();
    });
  }

  /* —— 事件：委托 —— */
  picker.addEventListener('click', e => {
    /* 折叠箭头（仅树模式） */
    const chev = e.target.closest('.pick-chev');
    if (chev) {
      /* 阻止 label 把这次点击又转给内部的 checkbox */
      e.preventDefault();
      const id = chev.dataset.toggle;
      const node = Store.node(id);
      if (!node) return;

      const key = pOf(node);                          // ← id → 路径
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      drawTree();
      return;
    }

    if (isMulti) {
      /* checkbox 由浏览器自己切换；我们只同步内存里的 Set */
      const cb = e.target.closest('input[type=checkbox]');
      if (cb) {
        if (cb.checked) selected.add(cb.dataset.id);
        else selected.delete(cb.dataset.id);
        updateCount();
      }
      return;
    }

    /* 单选：点行 */
    const row = e.target.closest('.pick-row[data-pick]');
    if (!row) return;
    const id = row.dataset.pick;
    closeModal();
    if (opts.onPick) opts.onPick(id);
  });

  if (okEl) {
    okEl.addEventListener('click', () => {
      const ids = [...selected];
      if (!ids.length) { toast('至少选一个话题'); return; }
      closeModal();
      if (opts.onPickMulti) opts.onPickMulti(ids);
    });
  }

  return md;
}

/* 兼容旧调用 —— 单选移动目标 */
export function openMovePicker(title, excludeIds, cb) {
  return openTopicPicker({
    title: '移动到…',
    hint: title,
    excludeIds,
    onPick: cb,
  });
}
