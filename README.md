# zh-t2s

🌐 网页繁简体中文**双向转换**的 Tampermonkey 用户脚本 | **繁转简** / **简转繁** | 基于 OpenCC | 支持动态内容、白名单、快捷键。

[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-安装-670000?logo=greasyfork&logoColor=white)](https://greasyfork.org/zh-CN/scripts/585653-%E7%B9%81%E8%BD%AC%E7%AE%80-zh-t2s)
[![GitHub](https://img.shields.io/badge/GitHub-源码-181717?logo=github&logoColor=white)](https://github.com/weiningwei/zh-t2s)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.7.1-green)](CHANGELOG.md)

基于 [opencc-js](https://github.com/nk2028/opencc-js)（纯 JavaScript 版 OpenCC）实现，能依据上下文正确区分一对多字形。默认方向为繁→简，可通过油猴菜单或浮动按钮切换为简→繁。

## 效果演示

![效果演示：繁体网页转换前后对比](docs/before-after.png)

*左：转换前的繁体网页　|　右：开启脚本后的简体网页*

## 功能特性

**转换能力**

- **全量覆盖**：转换网页中的正文、标题、按钮文字、表单提示、图片说明等所有可见文本。
- **双向转换**：支持繁→简（默认）与简→繁，可通过油猴菜单或浮动按钮随时切换。
- **上下文感知**：依据上下文正确区分一对多字形——繁转简时「乾隆」不会误作「干隆」；简转繁时「发展」→「發展」、「头发」→「頭髮」。只做字形转换，不改变地区用词（如「軟體」不会变成「软件」）。
- **动态内容自动转换**：页面通过 AJAX、路由切换等方式动态加载或插入的文本会自动跟着转换，无需刷新。

**性能与稳定**

- **浏览不卡顿**：转换在浏览器空闲时分批进行，超长页面也不会影响你正常滚动与点击。
- **智能性能优化**：自动跳过不含中文的内容，海量文本页面也几乎无感。
- **不破坏页面**：自动跳过代码、样式、输入框等区域，不会改动你正在输入的内容，也不会误入广告 / 跟踪类框架。
- **稳定可靠**：长时间浏览不会因反复转换而卡死或陷入死循环。
- **不打扰输入**：在输入框或富文本中打字时，不会被转换打断。

**交互与控制**

- **浮动状态按钮**：右下角常驻胶囊按钮，实时显示当前状态（🟢繁→简 / 🟢简→繁 / ⚪已关闭 / ⚪已忽略 / ⚪未加载），可拖到屏幕任意位置并记住；点击展开扁平面板、右键直接切换方向。
- **扁平面板**：点击 FAB 展开面板，所有操作一步直达——方向分段、一键开关、白名单管理（加入/移出/清空）、重置与隐藏，无需子页面。
- **快捷键支持**：默认 F8 开关繁→简、F9 开关简→繁；在输入框中打字时快捷键不触发。
- **转换统计**：面板页眉实时显示已转换字符数与耗时（切换方向时重新计数）。

**自定义与容错**

- **白名单**：按域名排除特定站点不做转换，油猴菜单一键加入 / 移出 / 清空。
- **容错设计**：即使转换引擎的 CDN 加载失败，菜单与面板仍可正常使用，方便你管理白名单与重置等操作。
- **重置所有设置**：一键清除方向、快捷键、白名单与按钮偏好并恢复默认（带确认提示）。

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

点击浏览器右上角 Tampermonkey 扩展图标，菜单可见两个互斥方向项：

- `✅ 繁→简 [F8]` — 当前为繁→简方向，点击关闭
- `⏸ 简→繁 [F9]` — 当前为简→繁方向，点击关闭

点击当前方向项即关闭转换还原原文，点击另一方向项则切换方向。切换方向时先还原原文再用新方向重扫。

状态全局持久化，所有标签页共享。亦可点击右下角浮动按钮，在面板中操作方向分段与开关，或**右键直接切换方向**。

### 浮动状态按钮

安装后右下角出现常驻胶囊按钮，直观展示当前转换状态：

- **左键点击胶囊**：展开 / 收起扁平面板。
- **右键点击胶囊**：不经面板直接切换转换方向（繁→简 ↔ 简→繁）。
- **拖拽胶囊**：按住拖动可移动到屏幕任意位置，位置会被记住，刷新后仍保留。
- **面板内容**：方向分段 → 开关 → 白名单管理（加入/移出/清空）→ 重置所有设置 → 隐藏按钮，全部一步直达，无需子页面。
- 若隐藏了按钮，可通过油猴菜单的「👁 显示浮动按钮」重新开启。

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

默认快捷键：

| 快捷键 | 作用 |
| --- | --- |
| `F8` | 开关繁→简方向（开启时按则关闭，关闭时按则开启） |
| `F9` | 开关简→繁方向（从繁→简开启状态按 F9 会切换到简→繁） |

**表单跳过**：在 `<input>` / `<textarea>` / `contenteditable` 聚焦时，快捷键不响应，避免打断输入。

### 白名单

白名单中的域名不做任何转换，用于排除特定站点。

**操作方式**（面板或油猴菜单）：

- `➕ 加入白名单（当前域名）` / `➖ 移出白名单（当前域名）` — 一键将当前页域名加入或移出，实时生效
- `🗑 清空白名单（共 N 项）` — 清空所有白名单，需确认

**匹配规则**：按 `location.hostname` 精确匹配，不关心路径。如 `zh.wikipedia.org` 与 `en.wikipedia.org` 视为不同域名。

## 工作原理

| 模块 | 说明 |
| --- | --- |
| 转换器 | 按当前方向选择 `converters.t2s` 或 `converters.s2t` |
| 初始扫描 | `TreeWalker` + `TEXT_FILTER`（CJK 预检前置 + O(1) 父元素名跳过）；`querySelectorAll` 原生收集属性元素 |
| CJK 预检 | `HAS_CJK` 正则前置到 TreeWalker filter，纯 ASCII 文本不入队（减少队列 30-60%）；`ignoreCache` WeakMap 缓存 `.ignore-opencc` 祖先查询结果 |
| 分批调度 | `requestIdleCallback`（兜底 `setTimeout`），每帧最多 `CHUNK_SIZE=300` 个节点 |
| 动态内容 | `MutationObserver` 监听 `childList` / `characterData` / 可转换属性 |
| 死循环防护 | Observer 回调层用 `WeakMap` 预检自写回变更（`textState` / `attrState`），匹配则直接跳过不入队 |
| 开关还原 | 关闭或切换方向时 TreeWalker 遍历 DOM，按 `WeakMap` 记录的原始值还原 |
| 忽略元素 | `script,style,noscript,textarea,input,template,xmp,plaintext,iframe,object,embed` + `.ignore-opencc`（`ignoreCache` WeakMap 缓存，O(1) 查表） |
| iframe 隔离 | `@noframes` 元数据 + JS 防御性检测，防止在广告/跟踪 iframe 中重复运行 |

## 配置

脚本顶部的常量可按需调整：

```js
const IDLE_TIMEOUT = 2000; // requestIdleCallback 兜底超时（ms）
const CHUNK_SIZE   = 300;  // 每个空闲帧最多处理的节点数
```

- **限定站点**：修改元数据 `@match`，例如 `@match *://*.wikipedia.org/*`。
- **恢复 iframe 注入**：如需在 iframe 中也做转换，可去掉元数据中的 `@noframes`（默认已启用，防止无关广告/跟踪 iframe 中运行）。

## 许可证

[MIT](LICENSE)

## 链接

- [Greasy Fork 脚本页](https://greasyfork.org/zh-CN/scripts/585653-%E7%B9%81%E8%BD%AC%E7%AE%80-zh-t2s) — 在线安装与自动更新
- [GitHub 仓库](https://github.com/weiningwei/zh-t2s) — 源码与问题反馈
- [更新日志](CHANGELOG.md) — 版本变更记录
- [问题反馈](https://github.com/weiningwei/zh-t2s/issues) — Bug 报告与功能建议
