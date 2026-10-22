'use strict';
/* ================= topic-info.js =================
 * 话题详情页（Telegram 频道信息风格）：
 *   - 话题标题 / 路径 / 创建时间
 *   - 记录数、图片数、子话题数
 *   - 简介（保存到该话题目录的 _话题.json）
 *   - 图片缩略图墙（懒加载，点击打开灯箱）
 *
 * 对外：
 *   openTopicDetails(node)
 *
 * 依赖：utils / format / md / tree-utils / io / writer / ui / image
 */

import { esc, badgeHTML } from './utils.js';
import { fmtStamp, parseStamp } from './format.js';
import { IMG_RE } from './md.js';
import { pathTitles } from './tree-utils.js';
import { updateTopicMeta } from './io.js';
import { enqueue } from './writer.js';
import { openFullPage, toast, confirmDialog } from './ui.js';
import { createImageURLLoader, openTopicLightbox } from './image.js';

/* ---------- 收集 ---------- */

function collectImages(node) {
  const out = [];
  for (const e of node.entries) {
    IMG_RE.lastIndex = 0;
    let m;
    while ((m = IMG_RE.exec(e.text))) {
      if (!m[2]) continue;
      out.push({ path: m[2], alt: m[1] || '', entry: e });
    }
  }
  return out;
}

function statHTML(label, value) {
  return '<div class="topic-stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
}

/* ---------- 渲染 ---------- */

function renderDetails(node, images, introEditing, introDraft) {
  const path = pathTitles(node);
  const created = parseStamp(node.topicId);
  const createdText = Number.isFinite(created) ? fmtStamp(created) : '—';

  const thumbs = images.map((it, i) =>
    '<button type="button" class="ti-thumb loading"' +
      ' data-img-path="' + esc(it.path) + '"' +
      ' data-img-eid="' + esc(it.entry.id) + '"' +
      ' data-img-idx="' + i + '"' +
      ' title="' + esc(it.alt || it.path) + '">' +
      '<img alt="' + esc(it.alt || '') + '">' +
    '</button>'
  ).join('');

  const intro = (node.intro || '').trim();
  /* 时间精确到秒：去掉 fmtStamp 里的 .mmm 毫秒段 */
  const sec = s => String(s || '').replace(/\.\d{3}/, '');
  /* 简介的创建时间 / 最后更新时间：两者不同才显示「最近更新于」 */
  const introCreatedAt = typeof node.introCreatedAt === 'string' ? sec(node.introCreatedAt) : '';
  const introAt        = typeof node.introAt === 'string' ? sec(node.introAt) : '';
  const showIntroUpd   = !!introAt && !!introCreatedAt && introAt !== introCreatedAt;
  const introMeta =
    '<div class="topic-intro-meta">' +
      (introCreatedAt
        ? '简介创建于 ' + esc(introCreatedAt) +
          (showIntroUpd ? '<span class="dot">·</span>最近更新于 ' + esc(introAt) : '')
        : (intro ? '简介创建时间未记录（旧话题）' : '')) +
    '</div>';
  const introView = intro
    ? '<div class="topic-intro-view">' + esc(intro).replace(/\n/g, '<br>') + '</div>' + introMeta
    : '<div class="topic-intro-view empty">还没有简介</div>' + introMeta;
  const introEditor =
    '<textarea class="topic-intro" rows="4" placeholder="写一点这个话题的简介…">' +
      esc(introDraft) +
    '</textarea>' +
    '<div class="topic-hint">简介保存在话题目录的 _话题.json 里</div>';

  return '' +
    '<div class="topic-hero">' +
      badgeHTML(node) +
      '<div class="topic-hero-main">' +
        '<h2>' + esc(node.title) + '</h2>' +
        '<div class="topic-hero-path">' + esc(path) + '</div>' +
        '<div class="topic-hero-created">创建于 ' + esc(sec(createdText)) + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="topic-stats">' +
      statHTML('记录', node.entries.length) +
      statHTML('图片', images.length) +
      statHTML('子话题', node.children.length) +
    '</div>' +
    '<div class="topic-card">' +
      '<div class="topic-card-head">' +
        '<span>简介</span>' +
        '<div class="topic-card-actions">' +
          (introEditing
            ? '<button type="button" class="topic-cancel" data-intro-cancel>取消</button>' +
              '<button type="button" class="topic-save" data-intro-save>保存</button>'
            : '<button type="button" class="topic-edit" data-intro-edit>编辑</button>') +
        '</div>' +
      '</div>' +
      (introEditing ? introEditor : introView) +
    '</div>' +
    (images.length
      ? '<div class="topic-media-head">图片 · ' + images.length + '</div>' +
        '<div class="topic-media">' + thumbs + '</div>'
      : '<div class="topic-empty">这个话题还没有图片</div>');
}

/* ---------- 缩略图懒加载 ---------- */

async function loadThumb(el, loader) {
  const path = el.dataset.imgPath;
  const url = await loader.load(path);
  if (!el.isConnected) return;
  el.classList.remove('loading');
  if (!url) { el.classList.add('failed'); return; }
  const img = el.querySelector('img');
  if (img) img.src = url;
}

/* ---------- 对外 ---------- */

export function openTopicDetails(node) {
  if (!node) { toast('先选择一个话题'); return null; }
  if (!node._dir) { toast('话题还没准备好，请稍候'); return null; }

  const images = collectImages(node);
  const loader = createImageURLLoader(node);
  let thumbIO = null;

  let introEditing = false;
  let introSaving = false;
  let introDraft = node.intro || '';

  function bindIntroEditor(api) {
    if (!introEditing) return;
    const ta = api.el.querySelector('.topic-intro');
    if (!ta) return;

    ta.value = introDraft;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);

    ta.addEventListener('input', () => {
      introDraft = ta.value;
    });

    ta.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      leaveIntro(api);
    });

    /* 点“保存”时 blur 会先发生，所以延迟到 click 之后再看：
       如果 saveIntro 已经把 introSaving 置位，这里就不再重复弹窗。 */
    ta.addEventListener('blur', () => {
      setTimeout(() => {
        if (!introEditing || introSaving) return;
        if (!ta.isConnected) return;
        if (api.el.querySelector('.topic-intro') !== ta) return;
        leaveIntro(api);
      }, 0);
    });
  }

  function beginIntroEdit(api) {
    if (introEditing || introSaving) return;
    introDraft = node.intro || '';
    introEditing = true;
    api.redraw();
  }

  function exitIntroEdit(api) {
    introEditing = false;
    introDraft = node.intro || '';
    api.redraw();
  }

  async function saveIntro(api) {
    if (introSaving) return;
    const ta = api.el.querySelector('.topic-intro');
    const v = (ta ? ta.value : introDraft).trim();

    /* 没有改动：直接退出编辑态，不写盘 */
    if (v === (node.intro || '').trim()) {
      exitIntroEdit(api);
      return;
    }

    introSaving = true;
    const btn = api.el.querySelector('[data-intro-save]');
    if (btn) btn.disabled = true;

    try {
      /* 简介的创建时间只在第一次写入时定，之后只更新 introAt */
      const stamp = fmtStamp(Date.now());
      const introCreatedAt = node.introCreatedAt || stamp;
      const r = await enqueue(() => updateTopicMeta(node, {
        intro: v, introCreatedAt, introAt: stamp,
      }));
      if (!r.ok) {
        toast('简介保存失败：' + ((r.err && r.err.message) || r.err || '未知错误'));
        return;
      }
      node.intro = v;
      node.introCreatedAt = introCreatedAt;
      node.introAt = stamp;
      introEditing = false;
      introDraft = v;
      api.redraw();
      toast('简介已保存');
    } finally {
      introSaving = false;
    }
  }

  async function leaveIntro(api) {
    if (!introEditing || introSaving) return;
    const ta = api.el.querySelector('.topic-intro');
    const v = (ta ? ta.value : introDraft);

    /* 没有更改 → 静默退出 */
    if (v.trim() === (node.intro || '').trim()) {
      exitIntroEdit(api);
      return;
    }

    const ok = await confirmDialog(
      '保存修改？',
      '简介已被修改。要保存吗？',
      { okText: '保存', cancelText: '放弃' }
    );
    if (!introEditing) return;
    if (ok) await saveIntro(api);
    else exitIntroEdit(api);
  }

  const api = openFullPage({
    title: '话题详情',

    render: () => renderDetails(node, images, introEditing, introDraft),

    afterDraw: (api) => {
      if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
      const list = api.el.querySelector('.pp-list');
      const root = list || api.el;
      const thumbs = root.querySelectorAll('.ti-thumb[data-img-path]');
      if (thumbs.length) {
        thumbIO = new IntersectionObserver(entries => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const el = en.target;
            if (thumbIO) thumbIO.unobserve(el);
            loadThumb(el, loader);
          }
        }, { root, rootMargin: '400px 0px' });
        for (const el of thumbs) thumbIO.observe(el);
      }

      bindIntroEditor(api);
    },

    onEvent: async (ev, api) => {
      /* 简介：进入编辑 */
      if (ev.target.closest('[data-intro-edit]')) {
        beginIntroEdit(api);
        return;
      }

      /* 简介：取消，直接丢弃本次编辑 */
      if (ev.target.closest('[data-intro-cancel]')) {
        if (introSaving) return;
        exitIntroEdit(api);
        return;
      }

      /* 简介：保存 */
      if (ev.target.closest('[data-intro-save]')) {
        await saveIntro(api);
        return;
      }

      /* 缩略图 → 灯箱 */
      const th = ev.target.closest('.ti-thumb[data-img-path]');
      if (th) {
        const path = th.dataset.imgPath;
        const eid = th.dataset.imgEid;
        const entry = node.entries.find(e => e.id === eid)
          || (images.find(it => it.path === path) || {}).entry;
        if (entry) openTopicLightbox(node, entry, path, () => api.close());
        return;
      }
    },

    onClose: () => {
      if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
      loader.release();
    },
  });

  return api;
}
