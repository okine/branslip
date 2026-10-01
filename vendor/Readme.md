# vendor/ —— 第三方库

本目录存放项目直接使用的第三方库。
它们不通过 npm 管理，因为本项目是无构建步骤的纯静态前端应用。

## marked
- 来源：https://cdn.jsdelivr.net/npm/marked/
- 版本：v18.0.13
- 许可：MIT License
  - Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
  - Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)
- 用途：Markdown 文本 → HTML
- 文件：`marked.esm.js`

## marked-katex-extension
- 来源：https://cdn.jsdelivr.net/npm/marked-katex-extension/
- 版本：v5.1.13
- 许可：MIT License
  - Copyright (c) 2021 @markedjs
- 用途：把 `$...$` / `$$...$$` 数学公式交给 KaTeX 渲染
- 文件：`marked-katex-extension.mjs`
- 对等依赖：`marked`、`katex` —— 均在本目录内，通过 `index.html` 的 importmap 解析

## katex

- 来源：https://cdn.jsdelivr.net/npm/katex/
- 版本：v0.18.7
- 许可：MIT License
  - Copyright (c) 2013-2020 Khan Academy and other contributors
- 用途：数学公式排版引擎
- 文件：
  - `katex/katex.mjs` —— 核心模块，`index.html` 的 importmap 把它映射为 `katex`
  - `katex/katex.min.css` —— 样式，`index.html` 通过 `<link>` 引入
  - `fonts/` —— 字体文件，由 `katex.min.css` 按需引用

升级方式：重新下载覆盖对应文件，并在本 README 里更新版本号。



## 第三方许可证全文

### MIT License（适用于本目录下所有库）

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

