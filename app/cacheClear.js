'use strict';
/* ================= cacheClear.js =================
 * 统一的内存缓存 / 观察器 / 滚动记忆清理入口。
 *
 * 为什么单独一个文件：
 *   - 切换文件夹、重扫磁盘、连接新目录时，需要同时清 URL、MD、分页
 *     观察器、待发送图片和滚动记忆。散在各处很容易漏掉一项。
 *   - 以后加新缓存，只改这里，不用满项目找 clearXxx。
 *
 * 注意：
 *   - clearRuntimeCaches() 会 revoke 当前页面在用的 ObjectURL，
 *     调用后必须重新 render；它只用于"换目录 / 重扫 / 断连"这类
 *     整体重建场景。
 *   - 单条记录 / 单个话题的清理仍然走 image.js / md.js 的细粒度函数。
 */

import { Store } from './store.js';
import { clearPendingAll, clearPendingForNode, resetImgObserver } from './image.js';
import { clearMDCache } from './md.js';
import { clearEarlierObs, clearLaterObs, clearScrollState } from './entries-jump.js';

/**
 * 整体运行时缓存清理。
 * @param {{scrollMemo?: boolean}} [opts]
 */
export function clearRuntimeCaches(opts) {
  opts = opts || {};
  clearPendingAll();          // pending blobs + 所有 ObjectURL
  clearMDCache();             // Markdown 渲染缓存 + 字节计数
  clearEarlierObs();
  clearLaterObs();
  resetImgObserver();         // 断开旧 DOM 图片观察器，重建空观察器
  Store.ui.loadedStart = 0;
  Store.ui.loadedEnd = 0;
  if (opts.scrollMemo !== false) clearScrollState();
}

/** 单话题的图片资源清理（删除 / 移动 / 重命名目录时用） */
export function clearTopicCaches(nodeId) {
  if (!nodeId) return;
  clearPendingForNode(nodeId);
}

