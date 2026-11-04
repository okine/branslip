'use strict';
/* ================= composer.js =================
 * 输入框领域：写记录 / 回复 / 图片插入与预览 / Markdown 菜单 / 离开提醒。
 *
 * 导出：
 *   setReply(ent)         进入/退出回复态（entries.js 会用）
 *   refreshPreview()      刷新图片预览条（tree.js 切换话题时会用）
 *   wireComposer({...})   注入外部依赖
 *
 * 与其它模块的边界：
 *   - 需要 renderAll（在 app.js）→ 通过 wireComposer 注入
 *   - appendEntry / updateTopCount 从 entries.js 直接 import
 */

import { Storage } from './storage.js';
import { $, esc, uid } from './utils.js';
import { I } from './icons.js';
import { Store } from './store.js';
import { Mutate } from './mutate.js';
import { imgStamp,stampForWrite, nextCreatedAtMs, CLOCK_DRIFT_THRESHOLD } from './format.js';
import { buildRef, stripQuoteHeader, imageRefs } from './md.js';
import { appendMonthEntry } from './io.js';
import {
  processImage, getImageURL,
  stageImage, discardImage, takePendingBlob,
  pendingPathsOf, clearPendingForNode,   // ← 从 image.js 来
} from './image.js';
import { enqueue } from './writer.js';
import { toast } from './ui.js';
import { findNode } from './tree-utils.js';
import { appendEntry, updateTopCount } from './entries.js';

/* ---------- 依赖注入 ---------- */
let D = { renderAll: () => {} };
export function wireComposer(h) { Object.assign(D, h); }

/* ---------- DOM ---------- */
const ta = $('#inputArea');
const previewBox = $('#attachPreview');
/* key = nodeId + '\0' + path，value = { blob, name, node } */


/* ---------- 输入框自动高度 ---------- */
function autoGrow() {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
}

/* ============================================================
 * 回复态
 * ============================================================ */

let replyTo = null;


export function setReply(ent) {
  if (ent) {
    const body = stripQuoteHeader(ent.text) || ent.text;
    /* ★ 连着"这条记录属于哪个话题"一起记住。
       引用必须指向条目真正所在的话题 —— 先用 A 里的某条进回复态、
       再切到 B 发送时，Store.ui.selectedId 已经是 B 了，
       若拿它去 buildRef 就会写成指向 B 的引用（指向一条不存在的记录）。 */
    replyTo = {
      blockId: Mutate.entryBlockId(ent),
      text: body.slice(0, 80),
      node: Store.entry(ent.id)?.node || Store.node(Store.ui.selectedId) || null,
    };
  } else {
    replyTo = null;
  }
  /* ★ 互斥：进入回复 → 退掉关联 */
  if (ent) {
    relevanceTo = null;
    $('#relevanceBar')?.classList.remove('on');
  }
  
  $('#replyBar').classList.toggle('on', !!replyTo);
  $('#replyText').textContent = replyTo
    ? ('回复：' + replyTo.text.replace(/\s+/g, ' ').trim())
    : '';
  if (ent) ta.focus();
}

$('#replyCancel').addEventListener('click', () => setReply(null));


/* ============================================================
 * 关联态（Relevance）
 *
 * 与回复态平行：
 *   - 回复是 "我在回应某条"
 *   - 关联是 "我想起某条"
 * 两者互斥 —— 进入关联就退出回复，反之亦然。
 * ============================================================ */

let relevanceTo = null;

/* 关联标题是显式输入的标签；去掉会破坏 ∝ 头解析的字符 */
function cleanRelevanceTitle(t) {
  return String(t || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\]]/g, '')
    .trim()
    .slice(0, 60);
}

export function setRelevance(ent, title) {
  if (ent) {
    const body = stripQuoteHeader(ent.text) || ent.text;
    /* ★ 同 setReply：记住条目所属话题，别在发送时才去读当前选中话题 */
    relevanceTo = {
      blockId: Mutate.entryBlockId(ent),
      text: body.slice(0, 80),
      title: cleanRelevanceTitle(title),
      node: Store.entry(ent.id)?.node || Store.node(Store.ui.selectedId) || null,
    };
  } else {
    relevanceTo = null;
  }

  /* ★ 互斥：进入关联 → 退掉回复 */
  if (ent) {
    replyTo = null;
    $('#replyBar')?.classList.remove('on');
  }

  const bar = $('#relevanceBar');
  if (bar) {
    bar.classList.toggle('on', !!relevanceTo);
    const txt = $('#relevanceText');
    if (txt) {
      const preview = relevanceTo
        ? relevanceTo.text.replace(/\s+/g, ' ').trim().slice(0, 40)
        : '';
      txt.textContent = relevanceTo
        ? ('关联 · ' + (relevanceTo.title || '未命名') + (preview ? '：' + preview : ''))
        : '';
    }
  }
  if (ent) ta.focus();
}

/* 别名 —— 短名称，方便 wire 时用 */
export const setRelev = setRelevance;


$('#relevanceCancel')?.addEventListener('click', () => setRelevance(null));
/* ============================================================
 * 发送
 * ============================================================ */

/* 生成严格大于上一条的 createdAt。
   时钟回拨 / 同毫秒 → 用 last+1ms 保证顺序；超过 5 分钟的回拨给用户提示。 */
// composer.js
let _lastClockWarn = 0;

function nextCreatedAt(node) {
  const { ms, drift } = nextCreatedAtMs(node.entries, Date.now());
  if (drift >= CLOCK_DRIFT_THRESHOLD && Date.now() - _lastClockWarn > 60000) {
    _lastClockWarn = Date.now();
    const sec = Math.round(drift / 1000);
    const human = sec >= 60
      ? Math.round(sec / 60) + ' 分钟'
      : sec + ' 秒';
    setTimeout(() => toast(
      '⚠ 系统时间比上一条记录早了约 ' + human +
      '。本条按逻辑顺序写入，但显示时间可能不准，请检查系统时间。'
    ), 0);
  }
  return ms;
}
function flushPendingImages(n, text) {
  const refs = imageRefs(text)
    .filter(r => r.path.startsWith('attachments/'))
    .map(r => r.path.slice('attachments/'.length));

  /* 第一趟：把待写 blob 拿出来（takePendingBlob 会从 pending 里删掉） */
  const pending = new Map();
  const orphans = [];                    // 有引用但没有待写 blob 的图片名
  for (const name of refs) {
    const p = takePendingBlob(n, 'attachments/' + name);
    if (p) pending.set(name, p);
    else orphans.push(name);
  }

  for (const [name, p] of pending) {
    enqueue(async () => {
      const adir = await Storage.getDir(p.node._dir, 'attachments', { create: true });
      await Storage.writeBlob(adir, p.name, p.blob);
    });
  }

  /* 第二趟：没有 blob 的，可能是早就写到磁盘上的旧图（正常），
     也可能真的丢了（比如切话题时被清掉）。异步确认后只提示一次。 */
  if (orphans.length) {
    enqueue(async () => {
      const gone = [];
      let adir = null;
      try { adir = await Storage.getDir(n._dir, 'attachments', { create: false }); } catch (e) {}
      for (const name of orphans) {
        let kind = null;
        try { if (adir) kind = await Storage.exists(adir, name); } catch (e) {}
        if (!kind) gone.push(name);
      }
      if (gone.length) {
        toast('有 ' + gone.length + ' 张图片的数据已经丢了：' + gone[0] +
          (gone.length > 1 ? ' 等' : '') + '。正文仍保留引用，但会显示为缺图。');
      }
    });
  }
}

/**
 * 把输入框内容拼成最终写入的 entry 正文（回复 / 关联会加引用头）。
 *
 * **引用的 tid 取自"被引用条目所属的话题"，不是当前输入框所在的话题。**
 * 跨话题时两者不是同一个 node：先用 A 里的某条进回复态、再切到 B 发送，
 * 若拿 B 去 buildRef 就会写成指向 B 的引用 —— 那条记录根本不在 B。
 *
 * 纯函数，不读 Store / 不碰 DOM，方便单测。
 *
 * @param {string} v            输入框原文
 * @param {object} n            当前话题 node（新条目要写进它）
 * @param {object|null} reply     setReply 留下的 { blockId, text, node }
 * @param {object|null} relev     setRelevance 留下的 { blockId, text, node }
 */
export function buildEntryText(v, n, reply, relev) {
  if (relev) {
    const preview = relev.text.split('\n')[0].slice(0, 60);
    /* 关联标题优先用建立关联时输入的标签；老调用没有 title 时退回第一行 */
    const keyword = cleanRelevanceTitle(relev.title)
      || v.split('\n')[0].slice(0, 30)
      || '关联';
    const body = v.trim();                                      // 整段输入都进正文
    const srcNode = relev.node || n;
    return '> ' + preview + '\n' +
           '∝ ' + keyword + ' ' + buildRef(srcNode, relev.blockId) + '\n\n' +
           body;
  }
  if (reply) {
    const srcNode = reply.node || n;
    return '> ' + reply.text.split('\n')[0].slice(0, 60) + '\n' +
           '> ' + buildRef(srcNode, reply.blockId) + '\n\n' +
           v;
  }
  return v;
}

function send() {
  if (Store.ui.merged) {
    toast('时间流视图下不能直接写记录，请先选一个话题');
    return;
  }
  const n = findNode(Store.ui.selectedId); if (!n) return;
  if (n._pending) { toast('话题正在创建中，请稍候…'); return; }
  const v = ta.value.trim(); if (!v) return;
  try {
    const text = buildEntryText(v, n, replyTo, relevanceTo);
    const e = Store.addEntry(n, { id: uid(), text, createdAt: nextCreatedAt(n) });
    const addBid = Mutate.entryBlockId(e);
    e._tzOffset = -new Date().getTimezoneOffset();  // 显式记下写时区
    const tzBid = Mutate.entryBlockId(e);
    e._writeStamp = stampForWrite(e);               // 冻结，与 format.stampForWrite 一致
    Store.reindexEntry(e, n, [addBid, tzBid]);       // blockId 可能因时区/_writeStamp 变化
    
    setRelevance(null);
    setReply(null);
    flushPendingImages(n, text);
    enqueue(() => appendMonthEntry(n, e));
    ta.value = '';
    ta.style.height = 'auto';
    refreshPreview();
    /* ★ 新增：发送成功，清掉该话题的草稿 */
    const curId = Store.ui.selectedId;
    if (curId) Store.ui.drafts.delete(curId);
    appendEntry(n, e);
    updateTopCount();
    ta.focus();
  } catch (err) {
    console.error('[send] 出错', err);
    toast('发送失败：' + (err.message || err));
    D.renderAll();
  }
}

ta.addEventListener('input', () => {
  autoGrow();
  refreshPreview();
  /* 草稿：单点维护 —— 每次变化都写回当前话题 */
  const cur = Store.ui.selectedId;
  if (cur) {
    if (ta.value) Store.ui.drafts.set(cur, ta.value);
    else Store.ui.drafts.delete(cur);
  }
});
ta.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault(); send();
  }
});
$('#sendBtn').addEventListener('click', send);

/* 话题切换时由 tree.js 调用：把该话题的草稿放回输入框 */
export function restoreDraft(nodeId) {
  if (!ta || !nodeId) return false;
  const draft = Store.ui.drafts.get(nodeId) || '';
  if (ta.value === draft) return false;
  ta.value = draft;
  ta.dispatchEvent(new Event('input'));   // autoGrow + refreshPreview + 草稿回写
  return true;
}

/* ============================================================
 * 图片预览条
 * ============================================================ */

function previewKey(node, path) { return node.id + '\u0000' + path; }

function ensurePreviewURL(node, path) {
  const key = previewKey(node, path);
  if (Store.urlCache.has(key)) return;

  /* 走统一入口，不再自己 resolveFile + createObjectURL */
  getImageURL(node, path).then(url => {
    const chip = previewBox.querySelector(
      '.attach-chip[data-node="' + node.id + '"][data-path="' + CSS.escape(path) + '"]'
    );
    if (!chip) return;
    if (url) {
      const img = chip.querySelector('img');
      if (img && !img.src) { img.src = url; chip.classList.remove('loading'); }
    } else {
      chip.classList.remove('loading');
      chip.classList.add('failed');
    }
  });
}

let previewRaf = null;
export function refreshPreview() {
  if (previewRaf) return;
  previewRaf = requestAnimationFrame(() => { previewRaf = null; _refreshPreview(); });
}

function _refreshPreview() {
  const node = Store.node(Store.ui.selectedId);
  if (!node) { previewBox.innerHTML = ''; return; }

  const paths = imageRefs(ta.value)
    .filter(r => r.path.startsWith('attachments/'))
    .map(r => r.path);

  /* ★ 清理当前话题下、输入框里不再引用的 pending blob */
  const wantSet = new Set(paths);
  for (const path of pendingPathsOf(node.id)) {
    if (wantSet.has(path)) continue;
    discardImage(node, path);
  }

  if (!paths.length) {
    previewBox.style.display = 'none';
    previewBox.innerHTML = '';
    return;
  }
  previewBox.style.display = 'flex';

  /* 差量：删掉不再出现的 */
  const want = new Set(paths);
  for (const chip of [...previewBox.querySelectorAll('.attach-chip')]) {
    if (!want.has(chip.dataset.path)) chip.remove();
  }

  /* 按顺序补新的 / 重排 */
  paths.forEach((p, i) => {
    let chip = previewBox.querySelector(
      '.attach-chip[data-node="' + node.id + '"][data-path="' + CSS.escape(p) + '"]'
    );
    if (!chip) {
      chip = document.createElement('div');
      chip.className = 'attach-chip loading';
      chip.dataset.node = node.id;
      chip.dataset.path = p;
      chip.innerHTML = '<img alt=""><button class="ac-x" title="移除">✕</button>';
      previewBox.appendChild(chip);
    }
    const at = previewBox.children[i];
    if (at !== chip) previewBox.insertBefore(chip, at || null);

    const url = Store.urlCache.get(previewKey(node, p));
    if (typeof url === 'string') {
      const img = chip.querySelector('img');
      if (!img.src) { img.src = url; chip.classList.remove('loading'); }
    } else if (url === undefined) {
      ensurePreviewURL(node, p);
    } else if (url === false) {
      chip.classList.remove('loading'); chip.classList.add('failed');
    } else {
      /* Promise —— 加载中，什么都不做 */
    }
    /* url === null   → 加载中
       url === false  → 已失败 */
  });
}

/* 点 ✕ → 从 textarea 里删掉这条引用（顺带吞掉多余换行） */
previewBox.addEventListener('click', e => {
  const x = e.target.closest('.ac-x'); if (!x) return;
  const chip = x.closest('.attach-chip');
  const path = chip.dataset.path;


  /* ★ 新增：用户明确不要这张了，把未发送的 Blob 一并丢掉 */
  const cur = Store.node(Store.ui.selectedId);
  if (cur) discardImage(cur, path);
  const v = ta.value;
  const hit = imageRefs(v).find(r => r.path === path);
  if (!hit) return;

  let s = hit.index, e2 = hit.index + hit.raw.length;
  if (v[e2] === '\n') e2++;
  else if (v[s - 1] === '\n') s--;
  ta.value = v.slice(0, s) + v.slice(e2);
  ta.dispatchEvent(new Event('input'));
  ta.focus();
});

/* ============================================================
 * 插入图片
 * ============================================================ */

function insertRef(ref) {
  const v = ta.value, s = ta.selectionStart ?? v.length, e2 = ta.selectionEnd ?? s;
  const before = v.slice(0, s), after = v.slice(e2);
  const needNL = before && !/\n$/.test(before);
  ta.value = before + (needNL ? '\n' : '') + ref + '\n' + after;
  const pos = s + (needNL ? 1 : 0) + ref.length + 1;
  ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input'));
}

async function attachFiles(files) {
  if (Store.ui.merged) { toast('时间流视图下不能插入图片'); return; }
  const n = findNode(Store.ui.selectedId);
  if (!n) { toast('请先选择一个话题'); return; }
  if (n._pending) { toast('话题正在创建中，请稍候…'); return; }
  if (!Store.fs.ready) { toast('尚未连接文件夹'); return; }
  const imgs = files.filter(f => f.type && f.type.startsWith('image/'));
  if (!imgs.length) { toast('只支持图片文件'); return; }

  for (const f of imgs) {
    const { blob, ext } = await processImage(f);
    const name = 'img-' + imgStamp() + '-' + uid().slice(-4) + '.' + ext;
    const path = 'attachments/' + name;
    stageImage(n, path, blob, name);
    insertRef('![](attachments/' + name + ')');
    refreshPreview();
  }
  toast('已插入 ' + imgs.length + ' 张图片');
  ta.focus();
}

ta.addEventListener('paste', e => {
  const files = [...(e.clipboardData && e.clipboardData.files || [])]
    .filter(f => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); attachFiles(files); }
});

const filePick = document.createElement('input');
filePick.type = 'file';
filePick.accept = 'image/*';
filePick.multiple = true;
filePick.addEventListener('change', () => {
  if (filePick.files.length) attachFiles([...filePick.files]);
  filePick.value = '';
});
$('#attachBtn').addEventListener('click', () => filePick.click());

function hasFiles(e) {
  return e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}
let dragDepth = 0;
window.addEventListener('dragenter', e => {
  if (hasFiles(e)) { dragDepth++; document.body.classList.add('file-drag'); }
});
window.addEventListener('dragleave', e => {
  if (hasFiles(e)) {
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('file-drag'); }
  }
});
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  dragDepth = 0;
  document.body.classList.remove('file-drag');
  if (!hasFiles(e)) return;
  e.preventDefault();
  const fs = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (fs.length) attachFiles(fs);
});

/* ============================================================
 * Markdown 格式化菜单
 * ============================================================ */

(function initMdMenu() {
  const mb = document.getElementById('mdBtn');
  if (!mb) return;
  mb.innerHTML = I.md;
  let menu = null;

  mb.addEventListener('mousedown', e => {
    e.preventDefault();
    if (menu) { menu.remove(); menu = null; return; }
    menu = document.createElement('div');
    menu.className = 'md-menu';
    const items = [
      ['粗体', '**x**', s => '**' + s + '**'],
      ['斜体', '*x*', s => '*' + s + '*'],
      ['删除线', '~~x~~', s => '~~' + s + '~~'],
      ['行内代码', '`x`', s => '`' + s + '`'],
      ['引用', '> ', s => s.split('\n').map(l => '> ' + l).join('\n')],
      ['代码块', '```', s => '```\n' + s + '\n```'],
      ['待补完', '#待补完', s => s === '格式化文字' ? '#待补完' : s + ' #待补完'],
    ];
    menu.innerHTML = items.map((it, i) =>
      '<button data-md="' + i + '"><span>' + it[0] + '</span><code>' + esc(it[1]) + '</code></button>'
    ).join('');
    document.body.appendChild(menu);
    const r = mb.getBoundingClientRect();
    menu.style.left = Math.max(8, r.left) + 'px';
    menu.style.top = Math.max(8, r.top - menu.offsetHeight - 8) + 'px';
    menu.addEventListener('mousedown', ev => ev.preventDefault());
    menu.addEventListener('click', ev => {
      const b = ev.target.closest('[data-md]'); if (!b) return;
      const it = items[+b.dataset.md];
      const s = ta.selectionStart, e2 = ta.selectionEnd;
      const sel = e2 === s ? '格式化文字' : ta.value.slice(s, e2);
      const wrapped = it[2](sel);
      ta.focus();
      ta.value = ta.value.slice(0, s) + wrapped + ta.value.slice(e2);
      ta.setSelectionRange(s + wrapped.length, s + wrapped.length);
      ta.dispatchEvent(new Event('input'));
      menu.remove(); menu = null;
    });
    setTimeout(() => document.addEventListener('pointerdown', function h(ev) {
      if (!menu || (!menu.contains(ev.target) && ev.target !== mb)) {
        if (menu) { menu.remove(); menu = null; }
        document.removeEventListener('pointerdown', h);
      }
    }), 0);
  });
})();

/* ============================================================
 * 离开前提醒
 * ============================================================ */

window.addEventListener('beforeunload', e => {
  const draftCount = Store.ui.drafts.size + ((ta && ta.value.trim()) ? 1 : 0);
  const editing = !!(Store.ui.editingEntry || Store.ui.renaming || Store.ui.creatingParent);
  const busy = Store.fs.pending > 0;
  if (!draftCount && !editing && !busy) return;

  if (!document.title.startsWith('⚠')) {
    if (busy)            document.title = '⚠ 磁盘写入中 · ' + document.title;
    else if (draftCount) document.title = '⚠ 有未发送的草稿 · ' + document.title;
  }

  e.preventDefault();
  e.returnValue = '';
  return '';
});

