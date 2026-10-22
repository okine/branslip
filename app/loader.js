'use strict';
/* ================= loader.js =================
 * 磁盘扫描：把目录树读成内存里的 node 树。
 *
 *   scanDir(dir, name)      读单个目录 → node
 *   scanChildren(dir)       读所有子目录 → node[]（按 _顺序.json 排）
 *
 * 只依赖 Storage / io / md / utils。不碰 UI。
 */

import { Storage } from './storage.js';
import { uid }     from './utils.js';
import { MONTH_RE } from './format.js';
import { parseEntries } from './md.js';
import {
  ENTRY_FILE, isReservedDir,
  readOrder, readPins, readFolds,
} from './io.js';
import { recoverTempFiles } from './writeSecurity.js';

export async function scanChildren(dir) {
  const kids = [];
  const items = await Storage.listEntries(dir);
  for (const { name, kind } of items) {
    if (kind === 'directory' && !isReservedDir(name)) {
      const sub = await Storage.getDir(dir, name);
      kids.push(scanDir(sub, name));
    }
  }
  const list = await Promise.all(kids);
  const order = await readOrder(dir);
  if (order) {
    const idx = new Map(order.map((n, i) => [n, i]));
    list.sort((a, b) => {
      const ka = idx.has(a._name) ? idx.get(a._name) : Infinity;
      const kb = idx.has(b._name) ? idx.get(b._name) : Infinity;
      return ka !== kb ? ka - kb : a.title.localeCompare(b.title, 'zh');
    });
  } else {
    list.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }
  return list;
}

export async function scanDir(dir, name) {
  await recoverTempFiles(dir);
  const node = {
    id: uid(), title: name, _name: name, _dir: dir,
    entries: [], children: [], _hasOldFile: false,
    /* 本次扫描中"读失败 / 解析失败"的月份文件名。写盘侧据此拒绝删除：
       内存里没有该月，不代表盘上没有（见 io.writeMonthFile）。 */
    _loadErrors: new Set(),
  };

  const jobs = [];
  node.topicId  = null;
  node.source   = null;
  node.sourceId = null;
  node.intro    = '';
  node.scroll   = null;
  try {
    const raw = await Storage.readText(dir, '_话题.json');
    const meta = JSON.parse(raw) || {};
    node.topicId  = meta.createdAt || null;
    node.source   = meta.source   || null;    // ★
    node.sourceId = meta.sourceId || null;    // ★
    node.intro    = typeof meta.intro === 'string' ? meta.intro : '';
    /* 简介的创建时间 / 最后更新时间（都在 _话题.json 里） */
    node.introCreatedAt = typeof meta.introCreatedAt === 'string' ? meta.introCreatedAt : null;
    node.introAt  = typeof meta.introAt === 'string' ? meta.introAt : null;
    if (meta.scroll && Number.isFinite(meta.scroll.top)) {
      node.scroll = { top: meta.scroll.top };
    }
  } catch (e) {}

  const items = await Storage.listEntries(dir);
  for (const { name: fn, kind } of items) {
    if (kind !== 'file') continue;
    if (fn === ENTRY_FILE || MONTH_RE.test(fn)) {
      if (fn === ENTRY_FILE) node._hasOldFile = true;
      jobs.push((async () => {
        try {
          const txt = await Storage.readText(dir, fn);
          const parsed = parseEntries(txt);
          /* 有 "## " 条目行却解析出 0 条 = 解析失败（不是空月份）。
             旧判断用 /^#\s/，而月份文件第一行恒为 "# 话题 · YYYY-MM"，
             所以这条告警从未触发过。 */
          if (!parsed.length && /^##\s/m.test(txt)) {
            node._loadErrors.add(fn);
            console.error('[scanDir] 有条目行但解析出 0 条，已标记为不可删除:',
              node.title, fn, txt.slice(0, 200));
          }
          node.entries.push(...parsed);
        } catch (e) {
          node._loadErrors.add(fn);
          console.error('[scanDir] 读取失败:', node.title, fn, e);
        }
      })());
    }
  }
  await Promise.all(jobs);
  node.entries.sort((a, b) => a.createdAt - b.createdAt);

  /* 去重：旧单文件合并、追加写入崩溃导致的双重落盘，都靠这里兜底 */
  {
    const seen = new Set();
    node.entries = node.entries.filter(e => {
      const k = e.createdAt + '\u0000' + e.text;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  const [pinned, folds, children] = await Promise.all([
    readPins(node),
    readFolds(node),
    scanChildren(dir),
  ]);
  node.pinned = pinned;
  node.folds = folds;
  node.children = children;
  return node;
}
