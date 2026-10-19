'use strict';
/* ================= io.js =================
 * 磁盘 IO 层。所有"读/写/删文件 + 目录操作"都在这里。
 *
 * 文件清单：
 *   _记录-YYYY-MM.md   记录内容（按月切分）
 *   _记录.md           旧格式（首次写入时迁移）
 *   _顺序.json         子话题排序
 *   _置顶.json         置顶记录的毫秒时间戳数组
 *   _折叠.json         折叠区间 {from,to}（毫秒）
 *   _回收站.json       已删除记录
 *   _话题.json         话题 createdAt（引用系统的根）
 *   .trash/            已删除话题目录
 * 「复制成功才返回；源目录由调用方负责删」
 */

import { Storage } from './storage.js';
import { Store }   from './store.js';
import {
  fmtStamp, monthKey, monthFileName, MONTH_RE, parseStamp,escapeEntryBody,
  stampForWrite,
} from './format.js';
import { nextCreatedAtMs } from './composer-time.js';

/* ---------- 文件名常量 ---------- */
export const ENTRY_FILE = '_记录.md';
export const ORDER_FILE = '_顺序.json';
export const PIN_FILE   = '_置顶.json';
export const FOLD_FILE  = '_折叠.json';
export const TRASH_FILE = '_回收站.json';
export const TRASH_MAX  = 200;
export const TRASH_DIR     = '_trash';   /* 新 */
const        TRASH_DIR_OLD = '.trash';   /* 旧，仅用于兼容读 */
import { atomicWriteText,  } from './writeSecurity.js';
/* 兼容旧调用点 —— theme.js / tree-ops.js / loader.js / boot.js /
   import-runtime.js 继续从 io.js 拿这两个函数。
   等所有 io-* 拆分做完，再统一把 import 路径改成 './writeSecurity.js'。 */






export async function findOrphanAttachments(node) {
  if (!node || !node._dir) return [];
  let adir;
  try { adir = await Storage.getDir(node._dir, 'attachments'); }
  catch (e) { return []; }

  /* 1. 收集本话题所有 entry 文本里引用的文件名 */
  const used = new Set();
  const RE = /!\[[^\]]*\]\(\s*attachments\/([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  for (const e of node.entries) {
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(e.text))) used.add(m[1]);
  }

  /* 2. 遍历附件目录，看哪些没被引用 */
  const orphans = [];
  for (const { name, kind } of await Storage.listEntries(adir)) {
    if (kind === 'file' && !used.has(name)) orphans.push(name);
  }
  return orphans;
}

export async function deleteOrphanAttachments(node) {
  const orphans = await findOrphanAttachments(node);
  if (!orphans.length) return 0;
  const adir = await Storage.getDir(node._dir, 'attachments');
  let n = 0;
  for (const name of orphans) {
    try { await Storage.removeEntry(adir, name); n++; } catch (e) {}
  }
  return n;
}

export async function readJson(dir, filename, validate, fallback) {
  if (!dir) return fallback;
  try {
    const data = JSON.parse(await Storage.readText(dir, filename));
    return validate(data) ? data : fallback;
  } catch (e) { return fallback; }
}

export async function writeJson(dir, filename, data) {
  if (!dir) return;
  await atomicWriteText(dir, filename, JSON.stringify(data, null, 2));
}

export const TOPIC_FILE = '_话题.json';

/**
 * 读改写话题元信息（_话题.json）。
 * 只合并 patch，保留 createdAt / source / sourceId 等旧字段。
 * 调用方负责把它放进 enqueue。
 */
export async function updateTopicMeta(node, patch) {
  if (!node || !node._dir) throw new Error('话题目录尚未就绪');
  let meta = {};
  try {
    const raw = JSON.parse(await Storage.readText(node._dir, TOPIC_FILE));
    if (raw && typeof raw === 'object') meta = raw;
  } catch (e) {}
  if (!meta.createdAt && node.topicId) meta.createdAt = node.topicId;
  const next = { ...meta, ...patch };
  await atomicWriteText(node._dir, TOPIC_FILE, JSON.stringify(next, null, 2));
  return next;
}

const isStrArr = a => Array.isArray(a) && a.every(x => typeof x === 'string');

/* ---------- 目录操作 ---------- */

export function sanitizeName(t) {
  let s = String(t || '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  s = s.replace(/^·+/, '');
  if (/^[._]/.test(s)) s = '·' + s;
  return s || '未命名';
}

export function dirOf(node) {
  if (!node) return null;
  return node.id === '__root__' ? Store.dir : node._dir;
}
/* 明确保留的目录名。以 '_' 开头但不在这个名单里的目录，
   视为用户自己的话题，照常扫描。 */
   const RESERVED_DIRS = new Set([
    'attachments',
    '_trash',
    '.trash',
  ]);
  
  /* 点号开头的目录一律跳过：.git / .DS_Store / .svn / .vscode 等，
     用户不该把它们当话题。 */
  export const isReservedDir = name =>
    name.startsWith('.') || RESERVED_DIRS.has(name);

export async function uniqueName(parentDir, base) {
  const used = new Set();
  const items = await Storage.listEntries(parentDir);
  for (const it of items) used.add(it.name);
  if (!used.has(base)) return base;
  let k = 2;
  while (used.has(base + ' ' + k)) k++;
  return base + ' ' + k;
}

export async function moveDir(src, dstParent, name) {
  /* ── Tauri：一步 rename，不用逐文件复制 ── */
  if (Storage.isTauri) {
    const to = await Storage.moveDirTo(src, dstParent, name);
    return to;
  }

  /* ── Web：原逻辑不变 ── */
  const dir = await Storage.getDir(dstParent, name, { create: true });
  const items = await Storage.listEntries(src);
  try {
    for (const { name: n, kind } of items) {
      if (kind === 'file') {
        let moved = false;
        try {
          const fh = await src.getFileHandle(n);
          if (fh.move) { await fh.move(dir, n); moved = true; }
        } catch (e) { /* fh.move 不存在 → 走复制 */ }
        if (!moved) {
          const f = await Storage.getFile(src, n);
          await Storage.writeBlob(dir, n, f);
        }
      } else {
        const sub = await Storage.getDir(src, n);
        await moveDir(sub, dir, n);
      }
    }
  } catch (e) {
    try {
      await Storage.removeEntry(dstParent, name, { recursive: true });
    } catch (_) {}
    throw e;
  }
  return dir;
}

export async function refreshHandles(node) {
  for (const c of node.children) {
    c._dir = await Storage.getDir(node._dir, c._name);
    await refreshHandles(c);
  }
}

export async function resolveFile(dir, relPath) {
  const segs = relPath.split('/').map(s => s.trim()).filter(Boolean);

  /* Tauri：路径不是句柄，包一个"伪句柄"给上层用。
     调用方都只用 .getFile()，返回 Blob 即可。
     （File System Access API 返回的 File 是 Blob 的子类，
      URL.createObjectURL 和 Storage.writeBlob 都能吃） */
  if (Storage.isTauri) {
    return {
      async getFile() {
        return Storage.getFile(dir, segs.join('/'));
      },
    };
  }

  /* Web：原逻辑不动 */
  let d = dir;
  for (let i = 0; i < segs.length - 1; i++) {
    d = await Storage.getDir(d, segs[i]);
  }
  return d.getFileHandle(segs[segs.length - 1]);
}
/**
 * 获取回收站目录句柄。
 *
 * - 优先 `_trash`
 * - `_trash` 不存在但 `.trash` 存在 → 读操作直接用 `.trash`；
 *   `create = true` 时把 `.trash` 整体迁移到 `_trash`
 * - 都没有 → `create` 时新建 `_trash`；否则抛错
 */
export async function getTrashDir(create = false) {
  try {
    return await Storage.getDir(Store.dir, TRASH_DIR, create ? { create: true } : {});
  } catch (e) {
    if (!Store.dir) throw e;

    /* 2. 回退 .trash */
    let oldDir = null;
    try {
      oldDir = await Storage.getDir(Store.dir, TRASH_DIR_OLD);
    } catch (e2) {
      throw e;   /* 都没有，抛原始错误 */
    }

    /* 3. 迁移：只在 create 时做，避免读操作改磁盘 */
    if (create) {
      try {
        const newDir = await Storage.getDir(Store.dir, TRASH_DIR, { create: true });
        const items = await Storage.listEntries(oldDir);
        for (const { name, kind } of items) {
          if (kind === 'directory') {
            const sub = await Storage.getDir(oldDir, name);
            await moveDir(sub, newDir, name);
          } else {
            const f = await Storage.getFile(oldDir, name);
            await Storage.writeBlob(newDir, name, f);
          }
        }
        await Storage.removeEntry(Store.dir, TRASH_DIR_OLD, { recursive: true });
        console.log('[trash] 已把 .trash 迁移到 _trash');
        return newDir;
      } catch (migrateErr) {
        console.warn('[trash] 迁移失败，继续用 .trash', migrateErr);
        return oldDir;
      }
    }

    /* 4. 只读场景直接返回旧句柄 */
    return oldDir;
  }
}
export async function copyAttachment(fromDir, toDir, relPath) {
  const segs = relPath.split('/').map(s => s.trim()).filter(Boolean);
  const srcHandle = await resolveFile(fromDir, relPath);
  const f = await srcHandle.getFile();
  let d = toDir;
  for (let i = 0; i < segs.length - 1; i++) {
    d = await Storage.getDir(d, segs[i], { create: true });
  }
  await Storage.writeBlob(d, segs[segs.length - 1], f);
}

/* ---------- 月份文件（记录内容） ---------- */

// writeMonthFile
export async function writeMonthFile(node, mk) {
  const fname = monthFileName(mk);
  const entries = node.entries.filter(e => monthKey(e.createdAt) === mk);
  if (!entries.length) {
    try { await Storage.removeEntry(node._dir, fname); } catch (e) {}
    return;
  }
  let md = '# ' + node.title + ' · ' + mk + '\n';
  for (const e of entries) {
    // ★ 原来：fmtStamp(e.createdAt)
    // ★ 现在：优先 _writeStamp / _rawStamp，跨时区稳定
    md += '\n## ' + stampForWrite(e) +
       (e.edited ? ('（已编辑' + (e.editedAt ? ' ' + fmtStamp(e.editedAt) : '') + '）') : '') + '\n\n';
    md += escapeEntryBody(e.text);
  }
  await atomicWriteText(node._dir, fname, md);
}

export async function appendMonthEntry(node, e) {
  await ensureMonthMigrated(node);
  const mk = monthKey(e.createdAt);
  const fname = monthFileName(mk);

  /* 该月第一次写 → 全量写（writeMonthFile 内部已经是 atomicWriteText） */
  const exists = await Storage.exists(node._dir, fname);
  if (!exists) return writeMonthFile(node, mk);

  /* 读全文 → 拼接 → 原子覆盖 */
  let old;
  try {
    old = await Storage.readText(node._dir, fname);
  } catch (err) {
    console.warn('[appendMonthEntry] 读取失败，改为全量重写', err);
    return writeMonthFile(node, mk);
  }

  const prefix = old
    ? (old.endsWith('\n') ? '\n' : '\n\n')
    : '';

  const md = old + prefix +
    '## ' + stampForWrite(e) + '\n\n' +
    escapeEntryBody(e.text);

  await atomicWriteText(node._dir, fname, md);
}

export async function ensureMonthMigrated(node) {
  if (!node._hasOldFile) return;
  const byMonth = {};
  for (const e of node.entries) {
    const mk = monthKey(e.createdAt);
    (byMonth[mk] ||= []).push(e);
  }
  for (const mk of Object.keys(byMonth)) await writeMonthFile(node, mk);
  try { await Storage.removeEntry(node._dir, ENTRY_FILE); } catch (e) {}
  node._hasOldFile = false;
}

export async function writeEntriesFile(node) {
  const existing = new Set();
  const items = await Storage.listEntries(node._dir);
  for (const { name } of items) {
    const m = name.match(MONTH_RE);
    if (m) existing.add(m[1]);
  }
  const byMonth = {};
  for (const e of node.entries) {
    const mk = monthKey(e.createdAt);
    (byMonth[mk] ||= []).push(e);
  }
  const allMks = new Set([...existing, ...Object.keys(byMonth)]);
  for (const mk of allMks) await writeMonthFile(node, mk);
  try { await Storage.removeEntry(node._dir, ENTRY_FILE); } catch (e) {}
  node._hasOldFile = false;
}

export async function persistMonthOf(node, ts) {
  await ensureMonthMigrated(node);
  await writeMonthFile(node, monthKey(ts));
}

/* ---------- 顺序清单 ---------- */

export async function readOrder(dir) {
  return readJson(dir, ORDER_FILE, isStrArr, null);
}

export async function writeOrder(parentNode) {
  const pdir = dirOf(parentNode);
  if (!pdir) return;
  const names = parentNode.children.map(c => c._name).filter(Boolean);
  await writeJson(pdir, ORDER_FILE, names);
}
/**
 * 用当前内存树重建所有 _顺序.json。
 * 遍历 root（含 __root__ 自己），每个节点写一遍。
 * 会覆盖已有文件 —— 重扫时调用，语义是"用新扫出来的顺序固化"。
 */
export async function rewriteAllOrders(rootNode) {
  let n = 0;
  const rec = async node => {
    try {
      await writeOrder(node);
      n++;
    } catch (e) {
      console.warn('[rewriteAllOrders] 写 _顺序.json 失败', node.title, e);
    }
    for (const c of node.children) await rec(c);
  };
  await rec(rootNode);
  return n;
}
/* ---------- 置顶 / 折叠 ---------- */

export async function readPins(parentNode) {
  const raw = await readJson(dirOf(parentNode), PIN_FILE, Array.isArray, []);
  const out = [];
  for (const item of raw) {
    if (typeof item === 'number') out.push(item);
    else if (typeof item === 'string') {
      const ms = parseStamp(item);
      if (ms != null) out.push(ms);
    }
  }
  return out;
}

export async function writePins(parentNode) {
  await writeJson(dirOf(parentNode), PIN_FILE, parentNode.pinned || []);
}

export async function readFolds(node) {
  const raw = await readJson(dirOf(node), FOLD_FILE, Array.isArray, []);
  const out = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const from = typeof f.from === 'number' ? f.from : parseStamp(f.from);
    const to   = typeof f.to   === 'number' ? f.to   : parseStamp(f.to);
    if (from == null || to == null || from > to) continue;
    out.push({ from, to });
  }
  return out;
}

export async function writeFolds(node) {
  await writeJson(dirOf(node), FOLD_FILE, node.folds || []);
}

/* ---------- 回收站（消息级） ---------- */

export async function readTrash() {
  return readJson(Store.dir, TRASH_FILE, Array.isArray, []);
}

export async function writeTrash(arr) {
  await writeJson(Store.dir, TRASH_FILE, arr);
}

export async function pushTrash(entry) {
  const arr = await readTrash();
  arr.unshift(entry);
  let dropped = 0;
  if (arr.length > TRASH_MAX) {
    dropped = arr.length - TRASH_MAX;
    arr.length = TRASH_MAX;
  }
  await writeTrash(arr);
  return { dropped };   // ← 调用方决定要不要提示
}

/* 列出 .trash/ 下的目录（话题级回收站） */
export async function readTrashDirs() {
  if (!Store.dir) return [];
  const out = [];
  /* 新格式：YYYY-MM-DD_HH-mm-ss-mmm    全平台合法 */
  const NEW_RE = /^(.*?)-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{1,3})$/;
  /* 旧格式：YYYY-MM-DD HH:mm:ss.mmm    Mac/Linux 上可能遗留 */
  const OLD_RE = /^(.*?)-(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{1,3})$/;

  try {
    const td = await getTrashDir();
    const items = await Storage.listEntries(td);
    for (const { name, kind } of items) {
      if (kind !== 'directory') continue;
      const m = name.match(NEW_RE) || name.match(OLD_RE);
      out.push({ name, mtime: m ? m[2] : '', title: m ? m[1] : name });
    }
  } catch (e) {}
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

/* ---------- 时之间（时间点 / 区间） ---------- */

export const TIMELINE_FILE = '_时之间.json';

/**
 * 时之间的定位 key 就是记录的 createdAt（毫秒）—— 和 entry 用 createdAt 当
 * 身份是同一套心智模型。
 *
 * 它和"区间从什么时候开始 / 时间点是什么时候"是**两件事**：
 *   createdAt  记录被记下的时刻，**只读，不可改**，用于唯一定位一条记录
 *   from / to  区间的起止（可改；to === null 表示进行中）
 *   at         时间点的时刻（可改）
 * 所以"现在开始"那条的 createdAt 和 from 初值相同，但改起点只动 from。
 *
 * 发号用 composer-time 的 nextCreatedAtMs：与上一条严格递增，同一毫秒连点
 * 两下也能拿到不同的号。区间和时间点共用同一个序号空间 —— 两者本来就在同
 * 一份文件里，共用一个空间省得再想"谁跟谁比"。
 */
function timelineStamp(existing, now) {
  return nextCreatedAtMs(existing, now).ms;
}

/** 时间线全部记录（区间 + 时间点）—— 只为了发号时看"上一条是谁"。 */
function timelineStamps(t) {
  const all = t.ranges.concat(t.points);
  all.sort((a, b) => a.createdAt - b.createdAt);  
  return all;
}
export async function readTimeline() {
  const raw = await readJson(Store.dir, TIMELINE_FILE,
    o => o && typeof o === 'object', {});
  /* 只保留带 createdAt 的记录。老数据（没有这个字段）会被丢掉 ——
     项目还在开发期，_时之间.json 里的历史数据按测试数据处理。 */
  const ranges = (Array.isArray(raw.ranges) ? raw.ranges : [])
    .filter(r => r && typeof r.createdAt === 'number')
    .sort((a, b) => a.createdAt - b.createdAt);
  const points = (Array.isArray(raw.points) ? raw.points : [])
    .filter(p => p && typeof p.createdAt === 'number')
    .sort((a, b) => a.createdAt - b.createdAt);
  return { points, ranges };
}

export async function writeTimeline(data) {
  await writeJson(Store.dir, TIMELINE_FILE, {
    points: data.points || [],
    ranges: data.ranges || [],
  });
}

/* 时间点：at = 那个时刻 */
export async function addTimelinePoint(at, label) {
  const t = await readTimeline();
  t.points.push({
    createdAt: timelineStamp(timelineStamps(t), Date.now()),
    at, label: label || '',
  });
  await writeTimeline(t);
  return t;
}

/* 区间：to = null 表示进行中 */
export async function addTimelineRange(from, to, label) {
  const t = await readTimeline();
  t.ranges.push({
    createdAt: timelineStamp(timelineStamps(t), Date.now()),
    from, to: to == null ? null : to, label: label || '',
  });
  await writeTimeline(t);
  return t;
}

/* ---------- 增删改：一律按 createdAt 定位 ----------
 *
 * 老实现拿 from / at 当 key，而 UI 又允许改它们 —— 改完一次，第二次操作
 * 就找不到自己了（去 find 新的值）；两个区间撞上同一个 from 还会串台。
 * createdAt 只读，所以这里的 key 永远命中当初那一条。
 */

export async function updateTimelineRange(createdAt, patch) {
  const t = await readTimeline();
  const r = t.ranges.find(x => x.createdAt === createdAt);
  if (!r) return null;
  if (patch.from != null) r.from = patch.from;
  if ('to' in patch)      r.to   = patch.to == null ? null : patch.to;
  if ('label' in patch)   r.label = String(patch.label || '');
  await writeTimeline(t);
  return r;
}

export async function removeTimelineRange(createdAt) {
  const t = await readTimeline();
  const before = t.ranges.length;
  t.ranges = t.ranges.filter(x => x.createdAt !== createdAt);
  if (t.ranges.length === before) return false;
  await writeTimeline(t);
  return true;
}

export async function updateTimelinePoint(createdAt, patch) {
  const t = await readTimeline();
  const p = t.points.find(x => x.createdAt === createdAt);
  if (!p) return null;
  if (patch.at != null)  p.at    = patch.at;
  if ('label' in patch)  p.label = String(patch.label || '');
  await writeTimeline(t);
  return p;
}

export async function removeTimelinePoint(createdAt) {
  const t = await readTimeline();
  const before = t.points.length;
  t.points = t.points.filter(x => x.createdAt !== createdAt);
  if (t.points.length === before) return false;
  await writeTimeline(t);
  return true;
}