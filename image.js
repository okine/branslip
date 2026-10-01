'use strict';
/* ================= image.js =================
 * 图像处理 + 渲染时懒水合。
 *
 *   processImage(file)          上传前压缩/缩放
 *   hydrateImages(scope)        观察 scope 下 img.eimg[data-src]，进视口才加载
 *   hydrateIn(container, node)  一次性水合（不懒加载）
 *   clearURLCache / clearURLCacheFor  清缓存
 */

import { Store } from './store.js';
import { resolveFile } from './io.js';
import { IMG_RE } from './md.js';
import { fmtDay, fmtTime } from './format.js';
import { openLightbox, toast } from './ui.js';
import { scrollIntoViewIn, flashEl } from './scroll-utils.js'
import {$} from './utils.js'

const MAX_EDGE = 2560;

function extFromMime(t) {
  return {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  }[t] || 'png';
}

export async function processImage(file) {
  try {
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
      return { blob: file, ext: extFromMime(file.type) };
    }
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await createImageBitmap(file); }
    if (Math.max(bmp.width, bmp.height) <= MAX_EDGE) {
      if (bmp.close) bmp.close();
      return { blob: file, ext: extFromMime(file.type) };
    }
    const s = MAX_EDGE / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const keepPng = file.type === 'image/png';
    const blob = await new Promise(r => c.toBlob(r, keepPng ? 'image/png' : 'image/jpeg', 0.92));
    return blob ? { blob, ext: keepPng ? 'png' : 'jpg' } : { blob: file, ext: extFromMime(file.type) };
  } catch (e) {
    return { blob: file, ext: extFromMime(file.type) };
  }
}

/* ---------- 懒水合 ---------- */

let imgObserver = null;

function makeImgObserver() {
  return new IntersectionObserver(function (entries) {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const img = en.target;
      this.unobserve(img);
      hydrateOneImage(img);
    }
  }, { root: null, rootMargin: '800px 0px' });
}

/** 渲染前调用：断开对旧 <img> 的强引用，重建观察器 */
export function resetImgObserver() {
  if (imgObserver) imgObserver.disconnect();
  imgObserver = makeImgObserver();
}

resetImgObserver();   // 首次建立

/* 水合单张图：外链直接设 src；本地图走 urlCache + resolveFile。
   外链不需要 node；本地图需要 node._dir。 */
   async function loadOne(img, node) {
    const path = img.dataset.src;
    if (!path) return;
    const url = await getImageURL(node, path);
    if (url === CACHE_CLEARED) return;
    if (url) {
      img.src = url;
      img.classList.add('ok');
      img.dataset.path = path;
      img.removeAttribute('data-src');
    } else {
      const s = document.createElement('span');
      s.className = 'img-missing';
      s.textContent = '图片缺失：' + path;
      img.replaceWith(s);
    }
  }

  async function hydrateOneImage(img) {
    const row = img.closest('[data-node]');
    const node = Store.node(row ? row.dataset.node : Store.ui.selectedId);
    await loadOne(img, node);
  }

  const hydratedSet = new WeakSet();
  export function hydrateImages(scope) {
    const root = scope || document.querySelector('#entries');
    for (const img of root.querySelectorAll('img.eimg[data-src]')) {
      if (hydratedSet.has(img)) continue;
      hydratedSet.add(img);
      imgObserver.observe(img);
    }
  }

export async function hydrateIn(container, node) {
  const jobs = [];
  for (const img of container.querySelectorAll('img.eimg[data-src]')) {
    jobs.push(loadOne(img, node));
  }
  await Promise.all(jobs);
}

/* ---------- 缓存清理 ---------- */

export function clearURLCache() {
  for (const u of Store.urlCache.values()) {
    if (typeof u === 'string') URL.revokeObjectURL(u);   // ← 只 revoke 真实 URL
  }
  Store.urlCache.clear();
}

export function clearURLCacheFor(nodeId) {
  const prefix = nodeId + '\u0000';
  for (const [k, u] of Store.urlCache) {
    if (k.startsWith(prefix)) {
      if (typeof u === 'string') URL.revokeObjectURL(u);
      Store.urlCache.delete(k);
    }
  }
}

/* ============================================================
 * 未发送图片的统一管理
 *
 * 两张 Map 曾经散在 composer.js：
 *   Store.urlCache     — 已提交图片的 ObjectURL（也可能有 pending 的）
 *   pendingBlobs       — 未发送图片的 Blob
 *
 * 现在收归到 image.js，key 统一为 nodeId + '\0' + path。
 *
 * 语义：
 *   stage   未发送图片进入内存（贴图 / 粘贴时）
 *   take    发送时从 pending 里取出 blob 用于写盘（取出即转出，不再需要 commit）
 *   discard 用户主动放弃这张（点 ✕）
 * ============================================================ */

const pendingBlobs = new Map();   // key → { blob, name, node }

/**
 * 把一张未发送的图片登记进内存。
 * 同时创建 ObjectURL 放进 Store.urlCache —— 与已提交图片共用缓存。
 */
export function stageImage(node, path, blob, name) {
  const key = node.id + '\u0000' + path;
  const old = Store.urlCache.get(key);
  if (typeof old === 'string') URL.revokeObjectURL(old);
  Store.urlCache.delete(key);

  pendingBlobs.set(key, { blob, name, node });
  Store.urlCache.set(key, URL.createObjectURL(blob));
}

/**
 * 用户主动放弃这张未发送的图片。
 */
export function discardImage(node, path) {
  const key = node.id + '\u0000' + path;
  pendingBlobs.delete(key);
  const cached = Store.urlCache.get(key);
  if (typeof cached === 'string') URL.revokeObjectURL(cached);
  Store.urlCache.delete(key);
}

/**
 * 取出未发送的 blob 用于写盘。取出即从 pending 中移除。
 * 返回 { blob, name, node } | null
 */
export function takePendingBlob(node, path) {
  const key = node.id + '\u0000' + path;
  const p = pendingBlobs.get(key);
  if (!p) return null;
  pendingBlobs.delete(key);
  return p;
}

/**
 * 列出某话题下所有未发送图片的 path。
 * 预览条差量清理用。
 */
export function pendingPathsOf(nodeId) {
  const prefix = nodeId + '\u0000';
  const out = [];
  for (const key of pendingBlobs.keys()) {
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

/**
 * 话题级清理：pending + URL 全清。
 * 场景：删除话题 / 重扫磁盘 / 切换存储 / 连接
 */
export function clearPendingForNode(nodeId) {
  if (!nodeId) return;
  const prefix = nodeId + '\u0000';
  for (const key of [...pendingBlobs.keys()]) {
    if (key.startsWith(prefix)) pendingBlobs.delete(key);
  }
  clearURLCacheFor(nodeId);
}

/**
 * 全库清理：pending + URL 全清。
 */
export function clearPendingAll() {
  pendingBlobs.clear();
  clearURLCache();
}
// image.js:getImageURL 里，Store.urlCache.set(key, url) 之后追加
const URL_CACHE_MAX = 100;

function evictOldestURL() {
  const firstKey = Store.urlCache.keys().next().value;
  if (firstKey === undefined) return;
  const v = Store.urlCache.get(firstKey);
  if (typeof v === 'string') URL.revokeObjectURL(v);
  Store.urlCache.delete(firstKey);
}


/* ============================================================
 * 获取图片 URL —— 全项目唯一入口
 *
 * urlCache 语义（统一后）：
 *   undefined   从未请求
 *   Promise     正在加载（并发去重）
 *   string      有 URL
 *   false       失败
 * ============================================================ */

const EXT_URL_RE = /^(https?:|data:|blob:)/i;

const CACHE_CLEARED = Symbol('cache-cleared');
export function getImageURL(node, path) {
  if (!path) return Promise.resolve(null);
  if (EXT_URL_RE.test(path)) return Promise.resolve(path);
  if (!node || !node._dir) return Promise.resolve(null);

  const key = node.id + '\u0000' + path;
  const cached = Store.urlCache.get(key);
  if (typeof cached === 'string') {
    /* LRU：命中即提到队尾，避免被过早淘汰 */
    Store.urlCache.delete(key);
    Store.urlCache.set(key, cached);
    return Promise.resolve(cached);
  }
  if (cached === false) return Promise.resolve(null);
  if (cached instanceof Promise) return cached;

  let p;
  p = (async () => {
    try {
      const fh = await resolveFile(node._dir, path);
      const url = URL.createObjectURL(await fh.getFile());
      /* ★ await 期间缓存可能被清空。此时 key 里不是 p 了，
         直接把刚创建的 URL 扔掉，不写回缓存。 */
      if (Store.urlCache.get(key) !== p) {
        URL.revokeObjectURL(url);
        return CACHE_CLEARED;
      }
      Store.urlCache.set(key, url);
      while (Store.urlCache.size > URL_CACHE_MAX) evictOldestURL();
      return url;
    } catch (e) {
      if (Store.urlCache.get(key) === p) Store.urlCache.set(key, false);
      return null;
    }
  })();
  Store.urlCache.set(key, p);
  while (Store.urlCache.size > URL_CACHE_MAX) {
    // 不要驱逐 p 自己（如果它是唯一的键）
    if (Store.urlCache.size === 1) break;
    const firstKey = Store.urlCache.keys().next().value;
    if (firstKey === key) {
      // 把 p 挪到队尾，换下一个
      Store.urlCache.delete(key);
      Store.urlCache.set(key, p);
      continue;
    }
    evictOldestURL();
  }
  return p;
}

/* ---------- 依赖注入（打破 entries.js ↔ image.js 循环） ---------- */
let D = { jumpToRow: () => {} };
export function wireImage(h) { Object.assign(D, h); }

/* ============================================================
 * 话题图片灯箱
 * ============================================================ */

export async function openTopicLightbox(node, curEntry, curPath) {
  if (!node || !node._dir) return;

  /* 1. 按记录顺序、文本顺序收集 { path, entry } */
  const all = [];
  for (const e of node.entries) {
    for (const m of e.text.matchAll(IMG_RE)) {
      all.push({ path: m[2], entry: e });
    }
  }
  if (!all.length) return;

  /* 2. 定位被点击那张（entry + path 双匹配，避免同图重复时错位） */
  let idx = all.findIndex(x => x.entry === curEntry && x.path === curPath);
  if (idx < 0) idx = all.findIndex(x => x.path === curPath);
  if (idx < 0) idx = 0;

  /* 3. 逐个准备 URL（失败跳过，不阻塞导航） */
  const items = [];
  const kept = [];
  for (let i = 0; i < all.length; i++) {
    const u = await getImageURL(node, all[i].path);
    if (u) {
      items.push({ src: u, alt: '', _entry: all[i].entry, _path: all[i].path });
      kept.push(i);
    }
  }
  if (!items.length) { toast('图片无法加载'); return; }

  let realIdx = kept.indexOf(idx);
  if (realIdx < 0) realIdx = 0;

  openLightbox(items, realIdx, {
    captionOf: it => fmtDay(it._entry.createdAt) + ' ' + fmtTime(it._entry.createdAt),
    onLocate: it => {
      const e = it._entry;
      const row = document.querySelector('#entries .entry-row[data-eid="' + e.id + '"]');
      if (row) {
        scrollIntoViewIn($('#entriesScroll'), row, { align: 'center' });
        flashEl(row);
      } else {
        D.jumpToRow(node, e.id);
      }
    },
  });
}