'use strict';
/* ================= platform.js =================
 * 平台判断的唯一入口。
 *
 * 规则：**不要**在别的模块里写 `window.__TAURI__` / `navigator.userAgent`
 * 这种手动判断；要平台信息就 import 这里的 PLATFORM。
 *
 *   PLATFORM.isTauri     Tauri 壳（桌面或手机）
 *   PLATFORM.isAndroid   Tauri + Android（没有系统文件夹对话框、要 MANAGE_EXTERNAL_STORAGE）
 *   PLATFORM.isDesktop   Tauri + 桌面（Windows/macOS/Linux）
 *   PLATFORM.isWeb       纯浏览器
 *   PLATFORM.isMobileWeb 手机浏览器（Android Chrome / iOS Safari）
 *
 *   invoke(cmd, args)    调 Tauri 命令；非 Tauri 环境直接抛错，别裸用 window.__TAURI__
 *   currentWindow()      Tauri 窗口对象（桌面关窗拦截用）；Web 返回 null
 *   canPickDirNative()  能不能用系统文件夹对话框（Android 不能）
 */

const hasWindow = typeof window !== 'undefined';
const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';

const isTauri = hasWindow && !!window.__TAURI_INTERNALS__;
const isAndroid = isTauri && /Android/i.test(ua);
const isDesktop = isTauri && !isAndroid;
const isWeb = !isTauri;
const isMobileWeb = isWeb && /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

export const PLATFORM = { isTauri, isAndroid, isDesktop, isWeb, isMobileWeb };

/** 调 Tauri 命令。非 Tauri 环境直接抛错，避免各处手写 window.__TAURI__.core.invoke。 */
export function invoke(cmd, args) {
  if (!isTauri) throw new Error('invoke 只能在 Tauri 里调用：' + cmd);
  return window.__TAURI__.core.invoke(cmd, args);
}

/** 当前窗口对象（Tauri 才有）。 */
export function currentWindow() {
  if (!isTauri) return null;
  const api = window.__TAURI__;
  return (api && api.window && api.window.getCurrentWindow)
    ? api.window.getCurrentWindow()
    : null;
}

/** 桌面可以用系统「选择文件夹 / 另存为」对话框；Android 没有目录选择器。 */
export function canPickDirNative() {
  return isTauri && !isAndroid;
}
