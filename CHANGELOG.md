# Changelog

本文件记录 zh-t2s 用户脚本的所有显著变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.4.6] - 2026-07-12

### 优化

- **`closest('.ignore-opencc')` 调用从 O(N) 降至 O(1)**：新增 `ignoreCache`（WeakMap）缓存元素是否有 `.ignore-opencc` 祖先，首次 miss 后同祖先的子节点缓存命中。大页面（数万文本节点）下避免重复 DOM 爬升。
- **CJK 预检前置到 TreeWalker filter**：`TEXT_FILTER` 将 CJK 判断从 `convertTextNode` 提前到入队阶段，纯 ASCII 文本节点（30-60%）不入队，缩小队列体积、减少 Set 操作与后续遍历。
- **`TEXT_FILTER` 提取为模块级常量**：避免每次 `enqueueSubtree` 新建 filter 对象，减轻 GC 压力。
- **MutationObserver characterData 补 CJK 预检**：非 CJK 字符变更（如数字、英文编辑）不再入队，与 TreeWalker 路径行为一致。

## [2.4.5] - 2026-07-12

### 修复

- **分批统计耗时偏低**：`processQueue` 在达到 `CHUNK_SIZE` 或空闲时间耗尽时会提前让出主线程，此前这些提前返回的批次没有把已处理时间计入 `stats.time`，导致大页面统计耗时偏低。现提前让出前也会结算本批耗时。
- **可编辑区动态输入保护**：`contenteditable` 内嵌套元素的文本变更现在会在 `MutationObserver` 入队前重新检查跳过条件，并增强 active editable 判定，避免用户正在编辑的内容被动态转换打断。

## [2.4.4] - 2026-07-07

### 修复

- **胶囊再次点击可靠关闭面板**：根因为胶囊按钮内含徽标/文案子元素，再次点击时 `e.target` 为子 `<span>` 而非按钮本身，导致「点击外部关闭」的捕获监听误判为外部点击而先关闭面板，随后按钮自身 handler 又重新打开，表现为"关不掉"。将 `onDocClickCloseFloat` 的 `e.target !== floatBtn` 改为 `!floatBtn.contains(e.target)`，使点击胶囊任一子元素都不视为外部点击，胶囊再次点击即可靠收起面板。

## [2.4.3] - 2026-07-07

### 优化

- **转换计时改为整批统计**：移除 `convertTextNode` / `convertAttributes` 内对每个节点各两次的 `performance.now()` 调用，改为在 `processQueue` 每批（最多 `CHUNK_SIZE` 个节点）统一计时一次，初始大页面扫描时省掉成千上万次计时器调用。
- **可编辑区判定改用原生属性**：`inActiveEditable` 由 `el.closest('[contenteditable="true"]')` 改为原生 `Element.isContentEditable`，避免对每个文本节点都向上遍历祖先链。

## [2.4.2] - 2026-07-07

### 修复

- **胶囊再次点击可靠关闭面板**：胶囊按钮的点击处理由调用 `toggleFloatPanel()` 改为根据 `floatPanelOpen` 状态显式关闭/展开，避免与「点击面板外部关闭」的捕获阶段监听存在事件时序冲突，确保面板展开后再次点击胶囊必定收起；同时移除因此产生的死代码 `toggleFloatPanel()`。

## [2.4.1] - 2026-07-06

### 修复

- **关闭后无法再次开启**：胶囊点击改为仅展开/收起设置面板，不再直接切换转换；面板主视图顶部新增明确开关键（蓝色 CTA），关闭态显示「开启转换（上次方向）」、开启态显示「关闭转换」。开启时沿用关闭前的方向，并通过 `zh-t2s-lastdir` 持久化，跨刷新也保留。
- 移除胶囊上的齿轮入口（面板由点胶囊打开），相关变量与样式一并清理，避免冗余。

## [2.4.0] - 2026-07-06

### 新增

- **浮动按钮支持拖动**：按住拖动可任意摆放，位置持久化（GM `zh-t2s-floatpos`），刷新后保留；移动超 5px 才判定为拖动，避免误触面板开关；「重置所有设置」一并复位到默认右下角。

### 优化

- **浮动 UI 视觉重做**：改用独立样式表（唯一前缀 `zh-t2s-`，不与页面样式冲突）。按钮改为渐变 FAB + 状态徽标（繁/简/中点）+ 关闭态转灰、hover 提亮与按压微缩；面板卡片化并加入 pop 入场动画；方向开关改为轨道式分段控件（选中段高亮过渡）；页眉用状态圆点 + 统计小字；危险操作（重置）红色弱化。整体更克制、有层级与反馈。

## [2.3.0] - 2026-07-06

### 优化

- **浮动面板分层重构**：主视图改为「状态页眉 + 分段方向开关（[繁→简 | 简→繁]）+ 关闭 + ⚙ 设置」，设置项（快捷键、白名单、重置、隐藏）收进「⚙ 设置」子面板，面板主屏从 5 个平铺行精简为 1 页眉 + 1 分段 + 2 按钮，消除视觉拥挤。
- **油猴菜单瘦身**：从 10 项精简为 4 项兜底（方向切换 ×2、重置所有设置、显示/隐藏浮动按钮），其余配置迁入面板设置屏，避免菜单过长。
- **状态行改为不可点页眉**，统计信息降级为页眉小字；重置按钮移至设置子面板底部并加分隔线、视觉弱化（破坏性操作与常用开关分离）。

## [2.2.0] - 2026-07-06

### 新增

- **重置所有设置**：浮动按钮面板与油猴菜单均新增「🔄 重置所有设置」项，一键清除方向、快捷键、白名单与浮动按钮偏好并恢复默认（带确认弹窗，避免误触；沿用仓库约定刷新页面以干净重启）。

## [2.1.0] - 2026-07-06

### 新增

- **页面内浮动状态按钮**：右下角常驻胶囊按钮，实时显示当前转换状态（🟢繁→简 / 🟢简→繁 / ⚪已关闭 / ⚪已忽略 / ⚪未加载）；点击展开面板可一键切换方向、关闭或隐藏按钮。按钮默认开启，可在油猴菜单「🙈 隐藏浮动按钮」关闭（状态持久化至 `zh-t2s-floatbtn`）；按钮带 `ignore-opencc` 类且用内联样式隔离页面 CSS，不会被转换也不会破坏页面布局。

### 修复

- **`convertAttributes` 未识别 `.ignore-opencc`**：此前仅文本节点跳过该类，带 `placeholder`/`title`/`alt`/`aria-label` 的元素属性仍可能被转换。现补充祖先链 `closest('.ignore-opencc')` 守卫，与 README 声明一致（同时保护浮动按钮自身属性）。

## [2.0.15] - 2026-07-05

### 优化

- **`shouldSkipText` 快速路径**：跳过节点判断先检查 `parentElement.nodeName`（O(1) Set.has），命中 script/style/textarea 等直接返回，避免对每个文本节点调 `closest()` 上溯祖先链。仅在稀有情况（`.ignore-opencc`、contenteditable）才走 `closest` 回退。
- **Observer 自写回过滤**：`characterData`/`attributes` 回调中先检查 `textState`/`attrState` 是否与当前 DOM 值一致，一致则跳过入队。消除"写回 → 触发观察者 → 入队 → 判等跳过"的无谓开销。
- **`processQueue` 取值优化**：`queue.values().next().value` 替代 `for..of` 迭代器取值，避免每节点创建新迭代器对象。

## [2.0.14] - 2026-07-05

### 修复

- **iframe 重复注册菜单**：Tampermonkey 沙箱中 JS 级 iframe 检测（`window.top !== window.self` / `location.href` 比较）在跨域场景下不可靠。改用元数据 `@noframes` 阻止 Tampermonkey 向 iframe 注入脚本，从源头杜绝广告/跟踪 iframe 注册菜单项。保留 JS 检测作防御性兼容。

## [2.0.13] - 2026-07-05

### 修复

- **iframe 菜单项泄露**：Tampermonkey 沙箱下跨域 iframe 的 `window.top` 可能不抛异常，导致 `window.top !== window.self` 检查失效。改用比较 `window.top.location.href !== window.location.href`，跨域 iframe 必然抛异常进入 catch 返回，彻底杜绝广告/跟踪 iframe 注册菜单项。

## [2.0.12] - 2026-07-05

### 修复

- **iframe 重复注册菜单**：`registerMenu` 的跨域 iframe catch 分支未 `return`，导致 `window.top` 抛 SecurityError 时穿透到 `refreshMenu()`，iframe 额外注册一套菜单项，多层 iframe 时菜单项成倍重复。

## [2.0.11] - 2026-07-05

### 修复

- **菜单状态与实际不一致**：白名单页/opencc-js 未加载时，菜单开关项仍显示 `✅`（依据全局持久化 `state`），但实际未转换。新增 `effectiveState()` 综合白名单和 opencc-js 可用性，`menuCaptionT2S`/`menuCaptionS2T`/`menuCaptionStatus` 改用该方法展示当前页真实生效状态。

### 新增

- `effectiveState()` 辅助函数，综合 `isWhitelisted` 和 `hasOpenCC` 返回当前页实际生效状态。

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
