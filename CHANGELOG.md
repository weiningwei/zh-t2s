# Changelog

本文件记录 zh-t2s 用户脚本的所有显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-07-05

### 性能

- **CJK 预检跳过非中文文本**：在 `convertTextNode` 与 `convertAttributes` 中加入 `HAS_CJK` 正则预检，不含汉字的文本（URL、数字、英文 UI）直接跳过 OpenCC 调用。典型网页 30-60% 文本节点受益。
- **`querySelectorAll` 收集属性元素**：`enqueueSubtree` 中 TreeWalker 改为只遍历 Text 节点；属性元素改用原生 `querySelectorAll('[placeholder],[title],[alt],[aria-label]')` 一次性查询。队列规模缩小 90%+，原生 C++ 实现快于 JS 逐元素 `hasAttribute`。
- **去除 `processQueue` 重复检查**：Text 节点不再二次调用 `shouldSkipText`。TreeWalker 收集时已过滤，characterData 变更来自已存在节点跳过状态不变。`MutationObserver` childList 分支新增的裸 Text 节点在入队时过滤，覆盖原本第二次检查保护的场景。

## [1.1.0] - 2026-07-05

### 新增

- **油猴菜单开关**：通过 `GM_registerMenuCommand` 注册菜单项，点击 Tampermonkey 扩展图标可见。菜单标题反映当前状态（`繁→简 转换：✅ 已开启` / `⏸ 已关闭`），切换时重新注册以更新标题。
- **状态持久化**：开关状态通过 `GM_setValue`/`GM_getValue` 存储在 Tampermonkey 全局存储，所有站点共享，刷新后保持。
- **跨框架同步**：同源 iframe 之间通过 `BroadcastChannel('zh-t2s')` 实时同步开关状态。
- **DOM 还原**：关闭转换时断开 observer、清空队列，并用 TreeWalker 遍历还原原始文本/属性值（`textOriginal`/`attrOriginal` WeakMap 记录）。已在外部被改动的节点不覆盖。

## [1.0.0] - 2026-07-05

### 新增

- **初始版本**：基于 opencc-js 标准 `t2s` 词典 + mmseg 短语分词，自动将网页繁体中文转为简体中文。
- **全量覆盖**：转换正文、标题、`placeholder`/`title`/`alt`/`aria-label` 等可见文本属性。
- **动态内容**：`MutationObserver` 监听 `childList`/`characterData`/`attributes`，自动转换异步加载内容。
- **分批调度**：`requestIdleCallback`（兜底 `setTimeout`）每帧最多处理 300 节点，不阻塞渲染。
- **死循环防护**：`WeakMap` 记录每个节点最近一次写入值，区分自身写入与外部改动。
- **安全跳过**：不修改 `script`/`style`/`noscript`/`textarea`/`input`/`template`/`iframe` 等元素内容。
- **编辑友好**：跳过当前聚焦的 `contenteditable` 区域，避免打断用户输入。
