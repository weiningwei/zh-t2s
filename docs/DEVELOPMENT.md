# 维护说明

用户安装与操作见 [README](../README.md)，版本历史见 [CHANGELOG](../CHANGELOG.md)。

## 源码与验证

`zh-t2s.user.js` 是唯一用户脚本源码，使用 IIFE，无构建步骤或包管理。直接修改后保存，在 Tampermonkey 中安装／重装，使用中文网页手动验证。

GitHub Actions 在 push、PR 和手动触发时运行轻量 CI：检查 JavaScript 语法、必要元数据，以及脚本 `@version`、面板显示版本常量 `SCRIPT_VERSION`、README 版本徽章和 CHANGELOG 最新发布版本的一致性。允许保留 `Unreleased` 开发记录，不要求每次修改都升级版本。

CI 同时运行 Node 内置测试，覆盖词典分隔符、JSON 导入／编辑／保存／导出往返、最长匹配与方向隔离、Unicode／ASCII 预检、保存失败保护、输入法合成与反馈定时器。测试在 VM 中加载完整用户脚本，仅注入测试用函数引用，使用最小的 DOM／GM 存储／定时器模拟；OpenCC 使用恒等转换器替身，不请求 CDN。这些检查不验证 OpenCC 字形字典、真实浏览器排版、事件冒泡或 Tampermonkey 兼容性，仍需手动验证。

版本防回退检查允许版本不变或按 major／minor／patch 升级。push 与推送前的提交比较，PR 与目标分支提交比较；工作流获取完整历史以读取基准脚本。首次推送新分支、手动运行和本地未指定基准时跳过该项，其余检查照常执行。基准存在却无法读取时会失败，不静默跳过。

本地安装 Node.js 24 后可执行同样的检查，无需安装依赖：

```sh
node --check zh-t2s.user.js
node .github/scripts/check-userscript.cjs
node --test .github/scripts/userscript.test.cjs .github/scripts/version-policy.test.cjs
```

本地也可将 `BASELINE_SHA` 环境变量设置为基准提交的完整 SHA，执行元数据检查时一并验证版本没有回退。

元数据检查会保护当前全站匹配、`@noframes`、`document-idle`、四项 GM 授权和固定版本的 jsDelivr OpenCC 依赖。若有意修改这些约定，请同步调整 `.github/scripts/check-userscript.cjs`。

按改动范围检查方向切换与原文还原、台湾／香港字形、动态内容、站点偏好及旧白名单兼容，以及词典的编辑／预览／导入导出。涉及存储时，还应检查跨页面同步、保存冲突与保存失败后的状态。

## 转换流程

| 环节 | 实现 |
| --- | --- |
| 转换器 | 繁→简 `t → cn`；简→繁 `cn → tw/hk`，按字形首次使用时构建并缓存 |
| 词典 | 按方向编译 Trie，原文同位置最长词优先；未命中的片段交给 OpenCC |
| 初始扫描 | TreeWalker 收集文本，原生选择器收集可转换属性元素 |
| 文本预检 | `mayConvertText` 跳过无汉字且不可能命中词典的文本；Unicode Han 检测覆盖扩展区 |
| 忽略区域 | `SKIP_TAGS`、`.ignore-opencc` 和正在编辑的富文本；祖先边界实时检查，空闲写入前再次确认 |
| 分批调度 | requestIdleCallback（无此 API 时用 setTimeout），每批最多 300 个节点 |
| 动态更新 | MutationObserver 监听子节点、文本和指定属性；点击后去抖重扫补漏 |
| 防止回环 | WeakMap 记录最近写入值，Observer 忽略自身写入；处理时再次跳过已转换节点 |
| 还原与重转 | WeakMap 记录页面最新原文；关闭时还原，方向／字形／词典改变时还原后重扫 |

`applyDictionary` 由页面转换和词典预览复用。`buildDictionaryTries` 不改动模块状态，预览使用草稿；保存成功后才安装新词典及预检状态。

## 浮动面板

保持扁平布局，依次为当前页状态、此网站偏好、全局默认、自定义词典和底部维护操作。站点设置使用独立卡片强调作用范围；繁体字形只在当前页简→繁时显示，并明确为所有网站共用。

`preferenceSelect` 统一构建原生选择控件，站点与全局分别调用各自的保存入口。`positionFloatPanel` 在内容重绘和窗口 resize 后重新定位，选择按钮上方或下方更大的空间，限制最大高度并允许滚动。关闭面板时移除窗口与键盘监听。设置重绘通过 `data-control` 还原焦点并保留滚动位置；Esc 关闭后将焦点返回原生浮动按钮。

## 存储与同步

| 设置 | GM 存储键 | 已打开页面的同步方式 |
| --- | --- | --- |
| 方向／开关 | `zh-t2s-enabled`、`zh-t2s-lastdir` | 同源 BroadcastChannel；其他站点刷新后读取 |
| 繁体字形 | `zh-t2s-traditional-style` | 同源 BroadcastChannel；其他站点刷新后读取 |
| 自定义词典 | `zh-t2s-dictionary` | 切回前台或打开编辑器时读存储，保存前检查冲突 |
| 站点偏好 | `zh-t2s-site-preferences` | 当前页立即生效，同源广播通知读存储，切回前台时重新读取 |
| 按钮显隐／位置 | `zh-t2s-floatbtn`、`zh-t2s-floatpos` | 当前页立即生效，其他页面刷新后读取 |

站点偏好格式为 `{ "example.com": "follow" | "t2s" | "s2t" | "off" }`，按 hostname 精确匹配，优先于全局 `state`。转换器、词典预检与匹配、字形变更、扫描和面板状态均使用 `effectiveState()`。菜单和面板“全局默认”修改全局设置；快捷键和按钮右键通过 `setPageState()` 沿用当前范围。

读取站点偏好时先将旧 `zh-t2s-whitelist` 合并为 `off`，再覆盖新设置，显式 `follow` 可解除旧排除项；首次保存会将合并后的配置持久化。保存前重读其他网站配置，写入成功后才切换当前页状态；重置同时清空新旧存储。测试覆盖站点方向与词典、开关还原、刷新持久化、精确域名、旧数据兼容、保存失败、同步及选择控件。

词典格式为 `{ t2s: [[source, target]], s2t: [[source, target]] }`，与 JSON 导入导出一致。快捷键仍读取 `zh-t2s-shortcut-t2s/s2t` 兼容旧偏好，当前无配置入口。

## 修改运行范围与调度

顶部常量可按需调整：

```js
const IDLE_TIMEOUT = 2000; // 空闲回调兜底超时（ms）
const CHUNK_SIZE = 300;    // 每批最多处理节点数
```

- 限定站点：修改元数据 `@match`，例如 `@match *://*.wikipedia.org/*`。
- iframe 转换：移除 `@noframes` 可允许 iframe 中的转换流程运行；菜单和浮动 UI 仍受顶层窗口检查保护。
- 保留元数据块格式。当前 grants 仅为四项 GM 菜单／存储 API，依赖版本由 `@require` 指定。

## 提交与发布

功能／修复代码及相关说明单独提交，变更先记到 CHANGELOG 的 `Unreleased`，不要同时修改发布版本号。

发布时另建 `chore(release): <version>` 提交，按 SemVer 同步更新脚本 `@version` 与 `SCRIPT_VERSION`、README 版本徽章，并将 Unreleased 内容移至带日期的对应版本条目。发布提交不混入功能代码；Greasy Fork 会从主分支拉取更新。
