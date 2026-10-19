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

import { esc, badgeHTML, countLabel } from './utils.js';
import { fmtStamp, parseStamp } from './format.js';
import { IMG_RE } from './md.js';
import { pathOf } from './tree-utils.js';
import { updateTopicMeta } from './io.js';
import { enqueue } from './writer.js';
import { openFullPage, toast } from './ui.js';
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

function renderDetails(node, images) {
  const path = pathOf(node).map(x => x.title).join(' / ');
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

  return '' +
    '<div class="topic-hero">' +
      badgeHTML(node) +
      '<div class="topic-hero-main">' +
        '<h2>' + esc(node.title) + '</h2>' +
        '<div class="topic-hero-path">' + esc(path) + '</div>' +
        '<div class="topic-hero-created">创建于 ' + esc(createdText) + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="topic-stats">' +
      statHTML('记录', countLabel(node.entries.length)) +
      statHTML('图片', countLabel(images.length)) +
      statHTML('子话题', countLabel(node.children.length)) +
    '</div>' +
    '<div class="topic-card">' +
      '<div class="topic-card-head">' +
        '<span>简介</span>' +
        '<button type="button" class="topic-save" data-intro-save>保存</button>' +
      '</div>' +
      '<textarea class="topic-intro" rows="4" placeholder="写一点这个话题的简介…">' +
        esc(node.intro || '') +
      '</textarea>' +
      '<div class="topic-hint">简介保存在话题目录的 _话题.json 里</div>' +
    '</div>' +
    (images.length
      ? '<div class="topic-media-head">图片 · ' + countLabel(images.length) + '</div>' +
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

  const api = openFullPage({
    title: '话题详情',

    render: () => renderDetails(node, images),

    afterDraw: (api) => {
      if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
      const list = api.el.querySelector('.pp-list');
      const root = list || api.el;
      const thumbs = root.querySelectorAll('.ti-thumb[data-img-path]');
      if (!thumbs.length) return;

      thumbIO = new IntersectionObserver(entries => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const el = en.target;
          if (thumbIO) thumbIO.unobserve(el);
          loadThumb(el, loader);
        }
      }, { root, rootMargin: '400px 0px' });
      for (const el of thumbs) thumbIO.observe(el);
    },

    onEvent: async (ev, api) => {
      /* 保存简介 */
      const save = ev.target.closest('[data-intro-save]');
      if (save) {
        const ta = api.el.querySelector('.topic-intro');
        if (!ta) return;
        const v = ta.value.trim();
        save.disabled = true;
        try {
          const r = await enqueue(() => updateTopicMeta(node, { intro: v }));
          if (!r.ok) return;
          node.intro = v;
          toast('简介已保存');
        } finally {
          save.disabled = false;
        }
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
