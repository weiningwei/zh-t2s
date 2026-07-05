# zh-t2s

一个 Tampermonkey 用户脚本，在网页中的**繁体中文**与**简体中文**之间双向转换。

[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-670000?logo=greasyfork&logoColor=white)](https://greasyfork.org/zh-CN/scripts/585653-%E7%B9%81%E8%BD%AC%E7%AE%80-zh-t2s)
[![GitHub](https://img.shields.io/badge/GitHub-源码-181717?logo=github&logoColor=white)](https://github.com/weiningwei/zh-t2s)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.9-green)](CHANGELOG.md)

基于 [opencc-js](https://github.com/nk2028/opencc-js)（纯 JavaScript 版 OpenCC）实现，内置 mmseg 短语分词，正确处理一对多映射（如 `乾隆` 中的 `乾` 不被误转为 `干`；简转繁时 `发展` 用 `發`、`头发` 用 `髮`）。默认方向为繁→简，可通过油猴菜单切换为简→繁。

## 效果演示

![效果演示：繁体网页转换前后对比](docs/before-after.png)

*左：转换前的繁体网页　|　右：开启脚本后的简体网页*

## 功能特性

- **全量覆盖**：转换正文、标题、按钮、表单提示（`placeholder`）、`title`、`alt`、`aria-label` 等所有可见文本。
- **双向转换**：支持繁→简（默认）与简→繁两个方向，通过油猴菜单切换。
- **上下文感知**：采用 OpenCC 词典 + 短语分词，正确解决一对多映射，仅做字形繁简转换，不改变地区用词。
- **动态内容**：通过 `MutationObserver` 监听 DOM 变化，自动转换异步加载或动态插入的节点。
- **不阻塞渲染**：使用 `requestIdleCallback` 分批处理，每帧最多处理 300 个节点，空闲时间耗尽即让出主线程。
- **性能优化**：CJK 预检跳过纯 ASCII 文本；`querySelectorAll` 原生查询属性元素；状态记录避免重复转换。
- **安全跳过**：不修改 `script` / `style` / `noscript` / `textarea` / `input` / `template` / `iframe` 等元素的内容，防止破坏页面功能。
- **无死循环**：通过状态记录区分"自身写入"与"外部写入"，避免转换回写触发观察者导致的无限循环。
- **编辑友好**：跳过当前聚焦的 `contenteditable` 区域，避免打断用户输入。
- **一键开关 + 方向切换**：油猴菜单两个互斥项，状态全局持久化，切换方向时还原原文并用新方向重转。
- **转换统计**：菜单显示当前页面已转换字符数与 OpenCC 耗时，会话级统计，切换方向时重置。
- **快捷键支持**：默认 F8 开关繁→简、F9 开关简→繁，可通过菜单自定义配置；表单聚焦时不响应；配置时检测与浏览器/另一方向快捷键冲突。
- **白名单**：按域名排除特定站点不做转换，菜单可一键加入/移出/清空；菜单状态项显示当前页是否转换。

## 安装

**方式一：Greasy Fork（推荐）**

点击 [Greasy Fork 脚本页](https://greasyfork.org/zh-CN/scripts/585653-%E7%B9%81%E8%BD%AC%E7%AE%80-zh-t2s) 的"安装此脚本"按钮，Tampermonkey 会自动识别并提示安装。后续 Greasy Fork 会定期拉取 GitHub 主分支的更新，无需手动重装。

**方式二：GitHub Raw**

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展。
2. 打开 [`zh-t2s.user.js`](zh-t2s.user.js)，点击 Raw 按钮，Tampermonkey 会自动识别并提示安装；或手动新建脚本粘贴内容。
3. 安装后访问任意繁体中文网页即可自动转换。

> 脚本通过 `@require` 从 jsDelivr CDN 加载 `opencc-js@1.4.0`（字典已在构建时打包进库，运行时不再请求字典）。若网络无法访问 CDN，控制台会输出 `[zh-t2s] opencc-js 未加载` 警告且不进行转换。

## 使用

安装后默认开启繁→简方向，访问任意繁体网页即自动转换。

### 切换方向与开关

点击浏览器右上角 Tampermonkey 扩展图标，菜单中可见两个互斥项：

- `繁→简 转换：✅ 开启中（点击关闭）` — 当前为繁→简方向
- `简→繁 转换（点击开启）` — 切换到简→繁方向

**点击当前方向项**：关闭转换，还原原文。
**点击另一方向项**：切换方向，先还原原文再用新方向重新转换。

状态全局持久化，所有标签页共享。

### 转换示例

| 场景 | 繁→简 | 简→繁 |
| --- | --- | --- |
| 正文 | 網頁中的繁體中文 → 网页中的繁体中文 | 网页中的简体中文 → 網頁中的簡體中文 |
| 标题 | `<title>維基百科</title>` → `维基百科` | `<title>维基百科</title>` → `維基百科` |
| 表单提示 | `搜尋` → `搜索` | `搜索` → `搜尋` |
| 词组保形 | 乾隆 → 乾隆（`乾` 不转 `干`） | 乾隆 → 乾隆（固定词不变） |
| 一对多映射 | — | 发展 → 發展 / 头发 → 頭髮（`发` 视上下文转 `發` 或 `髮`） |
| 动态内容 | AJAX 加载的文本自动转换 | 同左，按当前方向转换 |

### 忽略特定元素

给元素添加 `class="ignore-opencc"`，其子树不会被转换：

```html
<div class="ignore-opencc">
  這裡的繁體字保持不變
</div>
```

### 快捷键

默认快捷键（可在油猴菜单中自定义）：

| 快捷键 | 作用 |
| --- | --- |
| `F8` | 开关繁→简方向（开启时按则关闭，关闭时按则开启） |
| `F9` | 开关简→繁方向（从繁→简开启状态按 F9 会切换到简→繁） |

**配置方式**：点击油猴菜单中的 `⚙️ 繁→简快捷键：F8（点击配置）` 项 → 标题变为 `⌨️ 按下新快捷键...` → 按下任意键组合（如 `Ctrl+Shift+Z`）即完成配置。按 `Esc` 取消。

**表单跳过**：在 `<input>` / `<textarea>` / `contenteditable` 聚焦时，快捷键不响应，避免打断输入。配置模式下不受此限制。

### 白名单

白名单中的域名不做任何转换，用于排除特定站点。

**操作方式**（油猴菜单）：

- `➕ 加入白名单（当前域名）` — 一键将当前页域名加入名单，自动刷新生效
- `➖ 移出白名单（当前域名）` — 从名单移除当前域名，自动刷新恢复转换
- `🗑 清空白名单（共 N 项）` — 清空所有白名单，自动刷新生效

**状态查看**：菜单中的 `🟢 当前页：繁→简 转换中` / `⚪ 当前页：已忽略` 显示当前页转换状态。

**匹配规则**：按 `location.hostname` 精确匹配，不关心路径。如 `zh.wikipedia.org` 与 `en.wikipedia.org` 视为不同域名。

## 工作原理

| 模块 | 说明 |
| --- | --- |
| 转换器 | 按当前方向选择 `converters.t2s` 或 `converters.s2t` |
| 初始扫描 | `TreeWalker` 收集文本节点；`querySelectorAll` 收集属性元素 |
| CJK 预检 | `HAS_CJK` 正则跳过非中文文本，避免无谓的 OpenCC 调用 |
| 分批调度 | `requestIdleCallback`（兜底 `setTimeout`），每帧最多 `CHUNK_SIZE=300` 个节点 |
| 动态内容 | `MutationObserver` 监听 `childList` / `characterData` / 可转换属性 |
| 死循环防护 | `WeakMap` 记录每个节点最近一次写入值，相同则跳过 |
| 开关还原 | `WeakMap` 记录原始值，关闭时 TreeWalker 遍历还原 |
| 忽略元素 | `script,style,noscript,textarea,input,template,xmp,plaintext,iframe,object,embed,.ignore-opencc` |

## 配置

脚本顶部的常量可按需调整：

```js
const IDLE_TIMEOUT = 2000; // requestIdleCallback 兜底超时（ms）
const CHUNK_SIZE   = 300;  // 每个空闲帧最多处理的节点数
```

- **限定站点**：修改元数据 `@match`，例如 `@match *://*.wikipedia.org/*`。
- **不在 iframe 中运行**：在元数据中添加 `@noframes`。

## 许可证

[MIT](LICENSE)

## 链接

- [Greasy Fork 脚本页](https://greasyfork.org/zh-CN/scripts/585653-%E7%B9%81%E8%BD%AC%E7%AE%80-zh-t2s) — 在线安装与自动更新
- [GitHub 仓库](https://github.com/weiningwei/zh-t2s) — 源码与问题反馈
- [更新日志](CHANGELOG.md) — 版本变更记录
- [问题反馈](https://github.com/weiningwei/zh-t2s/issues) — Bug 报告与功能建议
