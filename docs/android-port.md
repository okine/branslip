# Android 移植准备清单

> 目标：先把「能打开、能读写、能导入」跑通，再处理分享/导出与 Play 签名。
> 不要一开始就追桌面端同等的“任意文件夹”能力；Android 的存储模型不同。

## 1. 当前环境检查

- `ANDROID_HOME` / `ANDROID_SDK_ROOT`：未设置
- Rust 已安装 target：仅 `x86_64-pc-windows-msvc`
- 已安装 JDK 目录：`F:\JAVA_filefolder`
- Tauri：`2.12.1`，CLI：`2.12.1`
- `src-tauri/Cargo.toml` 的 `crate-type` 已包含 `cdylib`，符合移动端要求

结论：**还不能直接 `tauri android init`**，先补 Android SDK/NDK 和 Rust Android target。

## 2. 已写入的 Android 配置

`src-tauri/tauri.conf.json`：

```json
"bundle": {
  "active": true,
  "targets": "all",
  "android": {
    "minSdkVersion": 24,
    "versionCode": 100105
  }
}
```

`package.json` 脚本：

```json
"android:init": "tauri android init",
"android:dev": "tauri android dev",
"android:build": "tauri android build --apk",
"android:aab": "tauri android build --aab"
```

`identifier` 保持：

```json
"identifier": "com.okine.shizhijian"
```

Android 首次发布前需要递增 `versionCode`；当前 `version` 为 `10.1.5`，`versionCode` 为 `100105`。

## 3. 本机工具链准备

1. 安装 Android Studio，至少安装：
   - Android SDK Platform 35
   - Android SDK Build-Tools
   - NDK
   - Android SDK Command-line Tools
2. 设置环境变量：
   - `ANDROID_HOME`
   - `ANDROID_SDK_ROOT`
   - `JAVA_HOME=F:\JAVA_filefolder`
   - 把 `%ANDROID_HOME%\platform-tools` 和 `%ANDROID_HOME%\cmdline-tools\latest\bin` 加进 `PATH`
3. 安装 Rust Android target：
   ```powershell
   rustup target add aarch64-linux-android
   rustup target add armv7-linux-androideabi
   rustup target add i686-linux-android
   rustup target add x86_64-linux-android
   ```
4. 初始化 Android 工程：
   ```powershell
   npm run tauri android init
   ```
   会生成 `src-tauri/gen/android`。先只跑模拟器 x86_64，再上真机 arm64。

## 4. 存储：Android 第一版用 app 私有目录

桌面版当前依赖“用户选择的任意文件夹”：

- Web：File System Access API
- Tauri 桌面：`plugin:dialog|open` 返回路径，Rust 直接 `read_dir` / `fs`
- Android：没有可用的 `showDirectoryPicker`，`dialog` 选目录也不应作为第一版依赖

建议第一版：

- 在 Rust 增加命令 `app_data_dir()`，返回 `app.path().app_data_dir()`。
- Android 启动时直接连接 `app_data_dir()/shizhijian`，不弹文件夹选择。
- 隐藏「更改存储文件夹」按钮（`fixed-buttons.js` 按平台过滤）。
- 数据仍在 `_话题.json` / `_记录-YYYY-MM.md`，不改磁盘格式。

后续再考虑 SAF（Storage Access Framework）读取用户共享目录。

## 5. 导入 / 导出

- 导入聊天 JSON：WebView 的 `<input type=file>` 在 Android 可用，读成 `File` 后写进 app 私有目录，问题不大。
- 导出 ZIP：`plugin:dialog|save` + Rust 任意路径写入在 Android 不可靠。
  - 第一版：导出到 app 私有目录，然后调系统分享（share sheet）。
  - 后续：接 `tauri-plugin-share` 或 Android SAF 的 `ACTION_CREATE_DOCUMENT`。
- 桌面工作区迁移到 Android：需要单独的「备份 / 恢复 ZIP」，不要依赖直接选文件夹。

## 6. UI / 交互

- `index.html` 的 viewport 加 `viewport-fit=cover`。
- `#app` 用 `100dvh`，并处理 `env(safe-area-inset-*)`。
- 触控目标至少 44px；hover 样式在 `@media (hover:none)` 下弱化。
- 侧栏在窄屏改为抽屉；composer 处理软键盘遮挡。
- Android 返回键/手势：需要拦截到 `Esc`/历史返回，避免直接退出 App；打开中的页面/模态优先关闭。
- 移除 Google Fonts 外链，改为本地字体或系统字体，保证离线首屏。

## 7. 性能预算

移动端首屏不要沿用桌面参数：

- `PAGE_SIZE=80` → Android 先降到 40
- `MERGED_INITIAL=120` → Android 先降到 60
- 图片继续懒加载；缩略图尺寸按设备像素比限制
- 长列表优先做“离屏 Markdown 延迟渲染”，再考虑完整虚拟化

## 8. 里程碑

### M1：能启动、能读写

- Android 工程能 `tauri android dev`
- app 私有目录能建话题、写记录、读回
- 图片能保存与显示

### M2：导入可用

- 聊天 JSON 导入
- 记录编辑、置顶、折叠、引用
- 滚动与页面切换不明显卡顿

### M3：导出与分享

- ZIP 导出到私有目录
- 系统分享 / 另存为
- 备份恢复

### M4：可发布

- `tauri android build --aab`
- keystore 签名
- Play 内部测试
- 真机测试：Android 10 / 13 / 14，arm64

## 9. 已知风险

1. **路径模型**：Rust 命令全部接收普通路径，SAF 的 `content://` URI 不能直接传给 `PathBuf`。
2. **返回键**：Tauri Android 默认返回行为可能直接退出，需要单独验证。
3. **WebView 差异**：`window.__TAURI__`、Blob URL、文件 input 在 Android WebView 行为需实测。
4. **后台/生命周期**：写盘、草稿、滚动持久化要在 `visibilitychange` / `pagehide` 前 flush。
5. **数据迁移**：Android 沙箱与桌面目录隔离，必须做显式备份/恢复。
