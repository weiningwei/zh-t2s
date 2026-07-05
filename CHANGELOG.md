# Changelog

本文件记录 zh-t2s 用户脚本的所有显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.1] - 2026-07-05

### 修复

- **关闭状态刷新后丢失**：`setState('off')` 存储的字符串 `'off'` 在启动读取时未匹配任何分支,被当作未知值回退到默认 `t2s`,导致关闭脚本后刷新页面又自动开启。新增 `saved === 'off'` 显式分支,并将 if-else 链改为以 `else` 兜底 `t2s`。

## [2.0.0] - 2026-07-05

### 新增

- **简→繁方向支持**：新增 `converters.s2t`（OpenCC `s2t` 方向），与原有 `t2s` 共存。两个 converter 实例共享 opencc-js 模块级字典，内存增量可忽略。
- **两个互斥菜单项**：油猴菜单同时显示 `繁→简` 与 `简→繁` 两项。点击当前活跃方向项则关闭；点击另一方向项则切换方向并开启。切换方向时先还原 DOM、清空所有状态 WeakMap，再用新方向重新扫描转换。
- **状态广播同步**：BroadcastChannel 消息格式改为 `{ type: 'zh-t2s-state', state }`，同步三态状态到同源 iframe。

### 变更

- **脚本改名**：`繁转简 (zh-t2s)` → `繁简转换 (zh-t2s)`，反映双向能力。
- **描述更新**：`@description` 三字段改为"在网页繁简中文之间双向转换"。
- **状态模型重构**：`let enabled = true`（布尔）→ `let state = 't2s'`（三态 `'off' | 't2s' | 's2t'`）。`applyEnabled`/`setEnabled` 重写为 `applyState`/`setState`。
- **WeakMap 改为 `let` 声明**：`textState`/`attrState`/`textOriginal`/`attrOriginal` 需支持清空重建，新增 `clearAllState()` 在方向切换时调用。
- **菜单注册重构**：`menuCmdId` 单值改为 `menuCmdIds` 数组，`refreshMenu` 注销所有再重新注册两项。

### 兼容

- **旧版偏好迁移**：保留 GM 存储 key `zh-t2s-enabled`，启动时读到旧值 `'1'` 当 `t2s`、`'0'` 当 `off`，平滑升级。

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
