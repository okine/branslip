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
import { imageRefs } from './md.js';
import { fmtDay, fmtTime } from './format.js';
import { openLightbox } from './ui.js';
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
    if (url === CACHE_CLEARED) {
      /* 缓存加载期间被清空：观察器已经 unobserve 了，必须重新挂回去，
         否则这张图会永远停在无 src、也不被观察的状态。 */
      hydratedSet.delete(img);
      imgObserver.observe(img);
      return;
    }
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

  /** 清掉 URL 缓存后，把已经水合的 <img> 还原成待水合状态并重新观察。
      否则它们还挂着被 revoke 的 ObjectURL、又没有 data-src，永远不会再加载。 */
  export function resetImageHydration(scope) {
    const root = scope || (typeof document !== 'undefined' ? document : null);
    if (!root) return;
    for (const img of root.querySelectorAll('img.eimg')) {
      /* 观察器已经重建，所有旧 img 都要重新登记，包括还没加载的。 */
      hydratedSet.delete(img);
      if (!img.dataset.path) continue;
      img.dataset.src = img.dataset.path;
      img.removeAttribute('src');
      img.classList.remove('ok');
    }
    hydrateImages(root);
  }

  /** 关闭全屏页时，把它里面还没进入视口的图片从全局观察器摘掉 */
  export function unobserveImages(scope) {
    if (!scope) return;
    for (const img of scope.querySelectorAll('img.eimg[data-src]')) {
      imgObserver.unobserve(img);
      hydratedSet.delete(img);
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

/* 已提交图片 URL 的占用字节，用于按内存而不是按张数淘汰 */
const urlSizes = new Map();
let urlCacheBytes = 0;

/* 未发送图片的 URL 独立成第二份缓存：浏览信息流不能把它淘汰掉 */
const pendingUrls = new Map();
let pendingBytes = 0;

function dropCachedURL(key) {
  const u = Store.urlCache.get(key);
  if (typeof u === 'string') URL.revokeObjectURL(u);
  Store.urlCache.delete(key);
  forgetCachedSize(key);
}

function forgetCachedSize(key) {
  const size = urlSizes.get(key) || 0;
  if (size) { urlSizes.delete(key); urlCacheBytes = Math.max(0, urlCacheBytes - size); }
}

function dropPendingURL(key) {
  const u = pendingUrls.get(key);
  if (typeof u === 'string') URL.revokeObjectURL(u);
  pendingUrls.delete(key);
  const size = urlSizes.get('p:' + key) || 0;
  if (size) { urlSizes.delete('p:' + key); pendingBytes = Math.max(0, pendingBytes - size); }
}

export function clearURLCache() {
  for (const u of Store.urlCache.values()) {
    if (typeof u === 'string') URL.revokeObjectURL(u);   // ← 只 revoke 真实 URL
  }
  Store.urlCache.clear();
  urlSizes.clear();
  urlCacheBytes = 0;
}

export function clearURLCacheFor(nodeId) {
  const prefix = nodeId + '\u0000';
  for (const [k, u] of Store.urlCache) {
    if (k.startsWith(prefix)) {
      if (typeof u === 'string') URL.revokeObjectURL(u);
      Store.urlCache.delete(k);
      const size = urlSizes.get(k) || 0;
      if (size) { urlSizes.delete(k); urlCacheBytes = Math.max(0, urlCacheBytes - size); }
    }
  }
  for (const k of [...pendingUrls.keys()]) {
    if (k.startsWith(prefix)) dropPendingURL(k);
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
 * URL 单独放进 pendingUrls —— 不再和已提交图片共用 LRU。
 */
export function stageImage(node, path, blob, name) {
  const key = node.id + '\u0000' + path;
  dropCachedURL(key);
  dropPendingURL(key);

  pendingBlobs.set(key, { blob, name, node });
  const url = URL.createObjectURL(blob);
  pendingUrls.set(key, url);
  const size = (blob && blob.size) || 0;
  if (size) { urlSizes.set('p:' + key, size); pendingBytes += size; }
}

/**
 * 用户主动放弃这张未发送的图片。
 */
export function discardImage(node, path) {
  const key = node.id + '\u0000' + path;
  pendingBlobs.delete(key);
  dropPendingURL(key);
}

/**
 * 取出未发送的 blob 用于写盘。取出即从 pending 中移除；
 * URL 转进已提交缓存，避免发送后预览闪一下重新加载。
 * 返回 { blob, name, node } | null
 */
export function takePendingBlob(node, path) {
  const key = node.id + '\u0000' + path;
  const p = pendingBlobs.get(key);
  if (!p) return null;
  pendingBlobs.delete(key);

  const url = pendingUrls.get(key);
  if (typeof url === 'string') {
    pendingUrls.delete(key);
    const psize = urlSizes.get('p:' + key) || 0;
    if (psize) { urlSizes.delete('p:' + key); pendingBytes = Math.max(0, pendingBytes - psize); }
    Store.urlCache.set(key, url);
    if (psize) { urlSizes.set(key, psize); urlCacheBytes += psize; }
    trimURLCache(key);
  }
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
  for (const key of [...pendingUrls.keys()]) {
    if (key.startsWith(prefix)) dropPendingURL(key);
  }
  clearURLCacheFor(nodeId);
}

/**
 * 全库清理：pending + URL 全清。
 */
export function clearPendingAll() {
  pendingBlobs.clear();
  for (const key of [...pendingUrls.keys()]) dropPendingURL(key);
  clearURLCache();
}
// image.js:getImageURL 里，Store.urlCache.set(key, url) 之后追加
const URL_CACHE_MAX = 100;
const URL_CACHE_BYTES_MAX = 128 * 1024 * 1024;   // 128 MB

function evictOldestURL() {
  const firstKey = Store.urlCache.keys().next().value;
  if (firstKey === undefined) return;
  dropCachedURL(firstKey);
}

/* 按"张数 + 字节"双上限淘汰；keepKey 是刚写入、本轮不能淘汰的键 */
function trimURLCache(keepKey) {
  while (Store.urlCache.size > URL_CACHE_MAX || urlCacheBytes > URL_CACHE_BYTES_MAX) {
    const firstKey = Store.urlCache.keys().next().value;
    if (firstKey === undefined) return;
    if (Store.urlCache.size === 1 && firstKey === keepKey) return;
    if (firstKey === keepKey) {
      const v = Store.urlCache.get(firstKey);
      Store.urlCache.delete(firstKey);
      Store.urlCache.set(firstKey, v);
      continue;
    }
    evictOldestURL();
  }
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

  /* 未发送图片优先走 pending 缓存：预览条不应该被信息流的 LRU 淘汰 */
  const pending = pendingUrls.get(key);
  if (typeof pending === 'string') return Promise.resolve(pending);

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
      const file = await fh.getFile();
      const size = (file && file.size) || 0;
      const url = URL.createObjectURL(file);
      /* ★ await 期间缓存可能被清空。此时 key 里不是 p 了，
         直接把刚创建的 URL 扔掉，不写回缓存。 */
      if (Store.urlCache.get(key) !== p) {
        URL.revokeObjectURL(url);
        return CACHE_CLEARED;
      }
      Store.urlCache.set(key, url);
      if (size) { urlSizes.set(key, size); urlCacheBytes += size; }
      trimURLCache(key);
      return url;
    } catch (e) {
      if (Store.urlCache.get(key) === p) Store.urlCache.set(key, false);
      return null;
    }
  })();
  forgetCachedSize(key);
  Store.urlCache.set(key, p);
  trimURLCache(key);
  return p;
}

/* ============================================================
 * 页面级图片 URL 加载器
 *
 * 灯箱 / 详情页专用：自己持有 ObjectURL，生命周期跟着页面走，
 * 不经过 Store.urlCache 的 100 项淘汰，也不会因为一次加载几百张图
 * 把别的图片 URL revoke 掉。按需 load()，release() 统一回收。
 * ============================================================ */

export function createImageURLLoader(node) {
  let released = false;
  const jobs = new Map();      // path → Promise<string|null>
  const urls = new Set();      // 真正创建的 ObjectURL

  return {
    load(path) {
      if (!path) return Promise.resolve(null);
      if (EXT_URL_RE.test(path)) return Promise.resolve(path);
      if (!node || !node._dir || released) return Promise.resolve(null);

      const hit = jobs.get(path);
      if (hit) return hit;

      const job = (async () => {
        try {
          const fh = await resolveFile(node._dir, path);
          const url = URL.createObjectURL(await fh.getFile());
          if (released) { URL.revokeObjectURL(url); return null; }
          urls.add(url);
          return url;
        } catch (e) {
          return null;
        }
      })();
      jobs.set(path, job);
      return job;
    },

    release() {
      if (released) return;
      released = true;
      for (const u of urls) URL.revokeObjectURL(u);
      urls.clear();
      jobs.clear();
    },
  };
}

/* ---------- 依赖注入（打破 entries.js ↔ image.js 循环） ---------- */
let D = { jumpToRow: () => {} };
export function wireImage(h) { Object.assign(D, h); }

/* ============================================================
 * 话题图片灯箱
 * ============================================================ */

export function openTopicLightbox(node, curEntry, curPath, afterLocate) {
  if (!node || !node._dir) return;

  /* 1. 按记录顺序、文本顺序收集 { path, entry } */
  const all = [];
  for (const e of node.entries) {
    for (const r of imageRefs(e.text)) {
      if (!r.path) continue;
      all.push({ path: r.path, entry: e });
    }
  }
  if (!all.length) return;

  /* 2. 定位被点击那张（entry + path 双匹配，避免同图重复时错位） */
  let idx = all.findIndex(x => x.entry === curEntry && x.path === curPath);
  if (idx < 0) idx = all.findIndex(x => x.path === curPath);
  if (idx < 0) idx = 0;

  /* 3. 不再预加载全部图片：只把路径交给灯箱，按当前索引懒加载。
     图片多时打开是即时的；loader 自己管理 URL，不受 urlCache 淘汰影响。 */
  const loader = createImageURLLoader(node);
  const items = all.map(x => ({ alt: '', _entry: x.entry, _path: x.path }));

  openLightbox(items, idx, {
    captionOf: it => fmtDay(it._entry.createdAt) + ' ' + fmtTime(it._entry.createdAt),
    resolve: it => loader.load(it._path),
    onClose: () => loader.release(),
    onLocate: it => {
      const e = it._entry;
      const row = document.querySelector('#entries .entry-row[data-eid="' + e.id + '"]');
      if (row) {
        scrollIntoViewIn($('#entriesScroll'), row, { align: 'center' });
        flashEl(row);
      } else {
        D.jumpToRow(node, e.id);
      }
      if (typeof afterLocate === 'function') afterLocate();
    },
  });
}