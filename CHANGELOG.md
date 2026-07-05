# Changelog

本文件记录 zh-t2s 用户脚本的所有显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.10] - 2026-07-05

### 修复

- **菜单注册容错**：`registerMenu` 中 `window.top !== window.self` 在 Tampermonkey 沙箱可能抛 SecurityError，改用 try/catch 包裹。`refreshMenu` 中每个 `GM_registerMenuCommand` 改为独立 try/catch，一项失败不影响其余项。

## [2.0.9] - 2026-07-05

### 修复

- **菜单不随 opencc-js 加载状态而消失**：opencc-js 加载失败时脚本会 `return` 退出，菜单永远不注册。改为始终注册菜单，仅禁用转换功能；`applyState`/`start` 中所有转换路径均受 `hasOpenCC` 守卫。

## [2.0.8] - 2026-07-05

### 修复

- **菜单不显示**：`GM_registerMenuCommand` 的 accessKey 参数仅接受单字符，已有项 `'c1'`/`'c2'` 及新增项 `'s2'`/`'cw'` 等多字符 key 导致注册异常，全部菜单项丢失。已移除所有 accessKey 参数。

## [2.0.7] - 2026-07-05

### 新增

- **白名单（不转换名单）**：按域名排除特定站点不做任何转换。
  - 数据存 `GM_setValue('zh-t2s-whitelist', [hostname, ...])`，字符串数组
  - 启动时计算 `isWhitelisted = whitelist.includes(location.hostname)`，白名单页不启动 observer
  - 菜单新增 3 项：
    - `🟢 当前页：繁→简 转换中` / `⚪ 当前页：已忽略` — 只读状态项
    - `➕ 加入白名单（域名）` / `➖ 移出白名单（域名）` — 一键操作，自动刷新生效
    - `🗑 清空白名单（共 N 项）` — 清空所有，自动刷新生效
  - 白名单页快捷键 F8/F9 不响应（`if (isWhitelisted) return`）
  - 匹配规则：按 `location.hostname` 精确匹配，不关心路径

## [2.0.6] - 2026-07-05

### 新增

- **快捷键冲突检测**：配置快捷键时检测两类冲突，有冲突则不保存并提示警告 3 秒。
  - 与另一方向快捷键相同（如配置 F8 给简→繁，但繁→简已是 F8）
  - 与浏览器/系统常见快捷键冲突（Ctrl+S/T/W/N/P/F 等 24 组，F1/F3/F5/F11/F12 等）
  - 警告期间菜单标题显示 `⚠️ {冲突说明}，请重新配置`，3 秒后自动恢复

## [2.0.5] - 2026-07-05

### 优化

- **菜单标题精简**：5 项菜单标题去除冗余文字，避免 Tampermonkey 菜单宽度截断。
  - 开关项：`繁→简 转换：✅ 开启中（点击关闭）[F8]` → `✅ 繁→简 [F8]`（24→12 字）
  - 统计项：`📊 已转 1234 字 / 56.3ms（点击刷新）` → `📊 1234字 / 56.3ms`（22→16 字）
  - 配置项：`⚙️ 繁→简快捷键：F8（点击配置）` → `⚙️ 繁→简键：F8`（17→11 字）
  - 去掉"转换""点击开启/关闭""点击配置""点击刷新"等显而易见的冗余文字，用 ✅/⏸ 图标直接表示状态

## [2.0.4] - 2026-07-05

### 新增

- **快捷键支持**：默认 F8 开关繁→简、F9 开关简→繁。在 `keydown` 捕获阶段监听，优先于页面脚本响应。
  - F8 在 t2s 开启时按则关闭，关闭时按则开启 t2s
  - F9 在 s2t 开启时按则关闭，从 t2s 开启状态按 F9 会切换到 s2t
  - 表单聚焦时（input/textarea/contenteditable）不响应，避免打断输入
- **快捷键自定义**：油猴菜单新增两项 `⚙️ 繁→简快捷键` / `⚙️ 简→繁快捷键`，点击进入捕获模式，下一次按键即为新快捷键。支持 Ctrl/Alt/Shift/Meta 修饰键组合。按 Esc 取消。配置持久化到 GM 存储。
- **菜单标题加快捷键提示**：两个开关项标题末尾显示当前快捷键，如 `繁→简 转换：✅ 开启中（点击关闭）[F8]`。

## [2.0.3] - 2026-07-05

### 修复

- **统计项菜单需手动刷新才显示数据**：转换完成后菜单仍显示初始 `0 字 / 0ms`，用户必须先点"刷新"才能看到真实统计。在 `processQueue` 队列处理完毕时自动调用 `refreshMenu`（带 1 秒节流，避免动态内容持续到来时频繁注销+重注册菜单项），用户打开油猴菜单即可看到最新数据。

## [2.0.2] - 2026-07-05

### 新增

- **转换统计展示**：油猴菜单新增第三个只读状态项 `📊 已转 X 字 / Yms（点击刷新）`，显示当前页面会话内已转换的字符数和 OpenCC 累计耗时。
  - 字符数：仅当 OpenCC 输出与输入不同时累加 `text.length`（同形字不计入）
  - 耗时：`performance.now()` 测量 `safeConvert` 调用，累计毫秒
  - 会话级统计，页面刷新即重置；切换方向时清零（避免还原+重转污染数据）
  - 点击状态项重新注册菜单以刷新数字（Tampermonkey 不支持实时更新菜单标题）

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
