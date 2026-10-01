'use strict';
/* ================= composer-time.js =================
 * 记录时间戳的计算规则。纯函数，无 DOM / 无 Store / 无 toast。
 *
 *   nextCreatedAtMs(entries, now)
 *     → { ms, drift }
 *       ms    下一条应该用的 createdAt
 *       drift 时钟回拨的毫秒数（0 表示正常）
 *
 * 调用方（composer.js）读 drift 决定要不要弹警告。
 */

const CLOCK_DRIFT_WARN_MS = 30 * 1000;

export function nextCreatedAtMs(entries, now) {
  const last = entries[entries.length - 1];
  if (!last || now > last.createdAt) return { ms: now, drift: 0 };
  return { ms: last.createdAt + 1, drift: last.createdAt - now };
}

export const CLOCK_DRIFT_THRESHOLD = CLOCK_DRIFT_WARN_MS;