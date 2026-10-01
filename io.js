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
  unescapeEntryBody,stampForWrite,
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

/* ---------- 通用 JSON 读写 ---------- */

/* ---------- 写入协议 ---------- */

/* .tmp 的完整性凭证。
   只有以此结尾，才说明写入过程完整走完了。
   目标文件永远不含它。 */
const TMP_TRAILER = '\n<<<SZJ-EOF>>>\n';

export async function atomicWriteText(dir, name, text) {
  const tmpName = name + '.tmp';

  /* 1. 把"打算写入的完整内容 + 凭证"存成 .tmp —— 崩溃恢复的唯一凭据 */
  const tmpFh = await dir.getFileHandle(tmpName, { create: true });
  const w = await tmpFh.createWritable();
  await w.write(text + TMP_TRAILER);
  await w.close();

  /* 2. 写目标文件（不含凭证） */
  const final = await dir.getFileHandle(name, { create: true });
  const w2 = await final.createWritable();
  await w2.write(text);
  await w2.close();

  /* 3. 校验 */
  const check = await Storage.readText(dir, name);
  if (check !== text) {
    /* 保留 .tmp —— 下次启动能恢复 */
    throw new Error('写入校验失败：' + name);
  }

  /* 4. 成功 —— 销毁凭证 */
  try { await dir.removeEntry(tmpName); } catch (e) {}
}

export async function recoverTempFiles(dir) {
  if (!dir) return 0;
  let recovered = 0;
  const items = await Storage.listEntries(dir);

  for (const { name, kind } of items) {
    if (kind !== 'file' || !name.endsWith('.tmp')) continue;
    const finalName = name.slice(0, -4);   // xxx.md.tmp → xxx.md

    try {
      const tmpText = await Storage.readText(dir, name);

      /* ★ 完整性检查：没有凭证 = 写入未完成 → 丢弃 */
      if (!tmpText || !tmpText.endsWith(TMP_TRAILER)) {
        await Storage.removeEntry(dir, name);
        console.log('[recover] 丢弃残缺的 .tmp:', name);
        continue;
      }

      const clean = tmpText.slice(0, -TMP_TRAILER.length);

      /* 结构校验：.json 剥掉凭证后必须能 parse */
      if (finalName.endsWith('.json')) JSON.parse(clean);

      /* ★ 覆盖前先备份现有目标 —— 万一 .tmp 是过期残留，
         用户的当前内容还能从 .bak 找回 */
      try {
        const f = await Storage.getFile(dir, finalName);
        await Storage.writeBlob(dir, finalName + '.bak', f);
        console.log('[recover] 现有文件已备份:', finalName + '.bak');
      } catch (e) {
        /* 目标不存在 —— 无需备份 */
      }

      /* 用完整内容覆盖目标 */
      const fh = await dir.getFileHandle(finalName, { create: true });
      const w = await fh.createWritable();
      await w.write(clean);
      await w.close();

      await Storage.removeEntry(dir, name);
      recovered++;
      console.log('[recover] 已恢复', finalName);
    } catch (e) {
      console.warn('[recover] 跳过损坏的', name, e);
    }
  }
  return recovered;
}
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
  for await (const [n] of parentDir.entries()) used.add(n);
  if (!used.has(base)) return base;
  let k = 2;
  while (used.has(base + ' ' + k)) k++;
  return base + ' ' + k;
}

export async function moveDir(src, dstParent, name) {
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
          await Storage.writeBlob(dir, n, f);   // 抛错会被外层捕获
        }
      } else {
        const sub = await Storage.getDir(src, n);
        await moveDir(sub, dir, n);              // 递归同样受保护
      }
    }
  } catch (e) {
    // 复制失败 → 清掉半成品，避免留下孤儿目录
    try {
      await Storage.removeEntry(dstParent, name, { recursive: true });
    } catch (_) {}
    throw e;                                     // 交给 enqueue 统一 toast
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
  return t.ranges.concat(t.points);
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