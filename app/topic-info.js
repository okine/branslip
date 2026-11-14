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
import { imageRefs } from './md.js';
import { pathTitles } from './tree-utils.js';
import { updateTopicMeta } from './io.js';
import { enqueue } from './writer.js';
import { openFullPage, toast, confirmDialog } from './ui.js';
import { createImageURLLoader, openTopicLightbox } from './image.js';
import { jumpToRow } from './entries-jump.js';

/* ---------- 收集 ---------- */

/* 图片和贴纸分开收集：
   - 图片：普通 ![](attachments/x)
   - 贴纸：![sticker:emoji](attachments/x)（有文件）或 :::sticker emoji:::（无文件兜底） */
function collectMedia(node) {
  const images = [];
  const stickers = [];
  for (const e of node.entries) {
    for (const r of imageRefs(e.text)) {
      const alt = r.alt || '';
      if (alt.startsWith('sticker:')) {
        stickers.push({ path: r.path, alt, emoji: alt.slice('sticker:'.length), entry: e });
      } else {
        images.push({ path: r.path, alt, entry: e });
      }
    }

    const re = /:::sticker[ \t]*([^\n:]*?)[ \t]*:::/g;
    let s;
    while ((s = re.exec(e.text))) {
      stickers.push({ noImage: true, emoji: (s[1] || '贴纸').trim(), entry: e });
    }
  }
  /* 最近的在最前；同一消息内的多张图保持正文顺序。 */
  const newestFirst = (a, b) => (b.entry.createdAt || 0) - (a.entry.createdAt || 0);
  images.sort(newestFirst);
  stickers.sort(newestFirst);
  const links = collectLinks(node);
  return { images, stickers, links };
}

/* ---------- 链接 ---------- */

const MD_LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_LINK_RE = /https?:\/\/[^\s<>"'）】，。；：！？]+/g;

function stripLinkNoise(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/:::think[\s\S]*?:::/g, ' ')
    .replace(/:::raw[\s\S]*?:::/g, ' ')
    .replace(/:::pin[\s\S]*?:::/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ');
}

function cleanLinkUrl(raw) {
  let u = String(raw || '').trim();
  u = u.replace(/[.,;:!?，。；：！？、]+$/g, '');
  u = u.replace(/[)\]】》]+$/g, '');
  return u;
}

function extractLinks(text) {
  const s = stripLinkNoise(text);
  const found = [];
  s.replace(MD_LINK_RE, (m, label, url) => {
    found.push({ url: cleanLinkUrl(url), label: String(label || '').trim() });
    return ' ';
  });
  const rest = s.replace(MD_LINK_RE, ' ');
  for (const m of rest.matchAll(BARE_LINK_RE)) {
    found.push({ url: cleanLinkUrl(m[0]), label: '' });
  }
  const out = [], seen = new Set();
  for (const f of found) {
    const url = cleanLinkUrl(f.url);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./i, ''); }
    catch (e) { continue; }
    if (!host) continue;
    seen.add(url);
    out.push({ url, label: f.label || url, host });
  }
  return out;
}

function linkPreview(text) {
  return stripLinkNoise(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function collectLinks(node) {
  const groups = [];
  for (const e of node.entries) {
    const urls = extractLinks(e.text);
    if (!urls.length) continue;
    groups.push({ entry: e, urls, preview: linkPreview(e.text) });
  }
  return groups.sort((a, b) => (b.entry.createdAt || 0) - (a.entry.createdAt || 0));
}

function renderLinkList(media) {
  if (!media.links.length) {
    return '<div class="topic-empty">这个话题还没有链接</div>';
  }
  return '<div class="topic-links">' + media.links.map(g => {
    const links = g.urls.map(u =>
      '<a class="topic-link-url" href="' + esc(u.url) + '" target="_blank" rel="noopener"' +
        ' title="' + esc(u.url) + '">' + esc(u.label) + '</a>' +
      '<span class="topic-link-host-inline">' + esc(u.host) + '</span>'
    ).join('');
    return '<div class="topic-link-row">' +
      '<div class="topic-link-head">' +
        '<span class="topic-link-host">' + esc(g.urls[0].host) + '</span>' +
        '<span class="topic-link-time">' + esc(fmtStamp(g.entry.createdAt)) + '</span>' +
        '<button type="button" class="topic-link-locate" data-link-eid="' + esc(g.entry.id) + '">定位</button>' +
      '</div>' +
      '<div class="topic-link-urls">' + links + '</div>' +
      (g.preview ? '<div class="topic-link-src">' + esc(g.preview) + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';
}

function statHTML(label, value) {
  return '<div class="topic-stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
}

/* ---------- 渲染 ---------- */

/* 媒体区：图片 / 贴纸两个横向标签，全部展示，不再分页 */
const MEDIA_BATCH = 80;

function renderMedia(media, state) {
  const pending = !!state.pending;   /* 静默话题：记录尚未加载 */
  const list = state.tab === 'sticker' ? media.stickers
    : state.tab === 'link' ? media.links : media.images;
  const total = list.length;
  const shown = Math.min(total, state.shown ? state.shown[state.tab] : MEDIA_BATCH);
  const slice = list.slice(0, shown);

  const tabs =
    '<div class="topic-media-bar">' +
      '<div class="topic-media-tabs">' +
        '<button type="button" class="media-tab' + (state.tab === 'image' ? ' on' : '') +
          '" data-media-tab="image">图片 · ' + (pending ? '未加载' : media.images.length) + '</button>' +
        '<button type="button" class="media-tab' + (state.tab === 'sticker' ? ' on' : '') +
          '" data-media-tab="sticker">贴纸 · ' + (pending ? '未加载' : media.stickers.length) + '</button>' +
        '<button type="button" class="media-tab' + (state.tab === 'link' ? ' on' : '') +
          '" data-media-tab="link">链接 · ' + (pending ? '未加载' : media.links.length) + '</button>' +
      '</div>' +
    '</div>';

  if (pending) {
    return tabs + '<div class="topic-empty">静默话题：记录尚未加载，图片、贴纸和链接暂不统计。' +
      '<br>打开话题并点击「加载记录」后会显示在这里。</div>';
  }

  if (state.tab === 'link') return tabs + renderLinkList(media);

  const grid = slice.map((it, i) => {
    const idx = i;
    if (it.noImage) {
      return '<div class="ti-thumb ti-sticker" title="' + esc(it.emoji || '贴纸') + '">' +
        esc(it.emoji || '贴纸') + '</div>';
    }
    return '<button type="button" class="ti-thumb loading' + (it.emoji ? ' ti-sticker-img' : '') + '"' +
      ' data-img-path="' + esc(it.path) + '"' +
      ' data-img-eid="' + esc(it.entry.id) + '"' +
      ' data-img-idx="' + idx + '"' +
      ' title="' + esc(it.emoji || it.alt || it.path) + '">' +
      '<img alt="' + esc(it.emoji || it.alt || '') + '">' +
    '</button>';
  }).join('');

  const empty = '<div class="topic-empty">这个话题还没有' +
    (state.tab === 'sticker' ? '贴纸' : state.tab === 'link' ? '链接' : '图片') + '</div>';

  return tabs + (total
    ? '<div class="topic-media">' + grid + '</div>' +
      (shown < total
        ? '<div class="topic-media-loadmore" data-media-loadmore>继续加载 · 还有 ' +
          (total - shown) + ' 个</div>'
        : '')
    : empty);
}

function renderDetails(node, media, state, introEditing, introDraft) {
  const path = pathTitles(node);
  const created = parseStamp(node.topicId);
  const createdText = Number.isFinite(created) ? fmtStamp(created) : '—';

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
      statHTML('记录', node.silent && !node._entriesLoaded ? '未加载' : node.entries.length) +
      statHTML('图片', node.silent && !node._entriesLoaded ? '未加载' : media.images.length) +
      statHTML('贴纸', node.silent && !node._entriesLoaded ? '未加载' : media.stickers.length) +
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
    renderMedia(media, state);
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

  const media = collectMedia(node);
  const mediaState = {
    tab: media.images.length ? 'image'
      : (media.stickers.length ? 'sticker'
      : (media.links.length ? 'link' : 'image')),
    pending: !!(node.silent && !node._entriesLoaded),
    shown: { image: MEDIA_BATCH, sticker: MEDIA_BATCH },
  };
  const loader = createImageURLLoader(node);
  let thumbIO = null;
  let moreIO = null;

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

    render: () => renderDetails(node, media, mediaState, introEditing, introDraft),

    afterDraw: (api) => {
      if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
      if (moreIO) { moreIO.disconnect(); moreIO = null; }
      const list = api.el.querySelector('.pp-list');
      const root = list || api.el;
      const more = root.querySelector('[data-media-loadmore]');
      if (more) {
        moreIO = new IntersectionObserver(entries => {
          if (!entries.some(e => e.isIntersecting)) return;
          const cur = mediaState.tab === 'sticker' ? media.stickers : media.images;
          mediaState.shown[mediaState.tab] = Math.min(cur.length,
            (mediaState.shown[mediaState.tab] || MEDIA_BATCH) + MEDIA_BATCH);
          api.redraw();
        }, { root, rootMargin: '500px 0px' });
        moreIO.observe(more);
      }
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
      /* 媒体标签：图片 / 贴纸 */
      const tabBtn = ev.target.closest('[data-media-tab]');
      if (tabBtn) {
        const t = tabBtn.dataset.mediaTab;
        if (t === 'image' || t === 'sticker' || t === 'link') {
          mediaState.tab = t;
          api.redraw();
        }
        return;
      }

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

      /* 无 IntersectionObserver 时的“继续加载”兜底 */
      if (ev.target.closest('[data-media-loadmore]')) {
        const cur = mediaState.tab === 'sticker' ? media.stickers : media.images;
        mediaState.shown[mediaState.tab] = Math.min(cur.length,
          (mediaState.shown[mediaState.tab] || MEDIA_BATCH) + MEDIA_BATCH);
        api.redraw();
        return;
      }

      /* 链接：定位原消息 */
      const linkLoc = ev.target.closest('[data-link-eid]');
      if (linkLoc) {
        const entry = node.entries.find(e => e.id === linkLoc.dataset.linkEid);
        if (entry) {
          jumpToRow(node, entry.id);
          api.close();
        }
        return;
      }

      /* 缩略图 → 灯箱 */
      const th = ev.target.closest('.ti-thumb[data-img-path]');
      if (th) {
        const path = th.dataset.imgPath;
        const eid = th.dataset.imgEid;
        const entry = node.entries.find(e => e.id === eid)
          || media.images.concat(media.stickers).find(it => it.path === path)?.entry;
        if (entry) openTopicLightbox(node, entry, path, () => api.close(), { newestFirst: true });
        return;
      }
    },

    onClose: () => {
      if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
      if (moreIO) { moreIO.disconnect(); moreIO = null; }
      loader.release();
    },
  });

  return api;
}
