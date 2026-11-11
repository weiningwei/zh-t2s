# 维护说明

用户安装与操作见 [README](../README.md)，版本历史见 [CHANGELOG](../CHANGELOG.md)。

## 源码与验证

`zh-t2s.user.js` 是唯一源码，使用 IIFE，无构建步骤、包管理或自动化测试基础设施。直接修改后保存，在 Tampermonkey 中安装／重装，使用中文网页手动验证。

按改动范围检查方向切换与原文还原、台湾／香港字形、动态内容、白名单，以及词典的编辑／预览／导入导出。涉及存储时，还应检查跨页面同步、保存冲突与保存失败后的状态。语法可通过 `node --check zh-t2s.user.js` 检查。

## 转换流程

| 环节 | 实现 |
| --- | --- |
| 转换器 | 繁→简 `t → cn`；简→繁 `cn → tw/hk`，按字形首次使用时构建并缓存 |
| 词典 | 按方向编译 Trie，原文同位置最长词优先；未命中的片段交给 OpenCC |
| 初始扫描 | TreeWalker 收集文本，原生选择器收集可转换属性元素 |
| 文本预检 | `mayConvertText` 跳过无汉字且不可能命中词典的文本；Unicode Han 检测覆盖扩展区 |
| 忽略区域 | `SKIP_TAGS`、`.ignore-opencc` 和正在编辑的富文本；祖先查询由 WeakMap 缓存 |
| 分批调度 | requestIdleCallback（无此 API 时用 setTimeout），每批最多 300 个节点 |
| 动态更新 | MutationObserver 监听子节点、文本和指定属性；点击后去抖重扫补漏 |
| 防止回环 | WeakMap 记录最近写入值，Observer 忽略自身写入；处理时再次跳过已转换节点 |
| 还原与重转 | WeakMap 记录页面最新原文；关闭时还原，方向／字形／词典改变时还原后重扫 |

`applyDictionary` 由页面转换和词典预览复用。`buildDictionaryTries` 不改动模块状态，预览使用草稿；保存成功后才安装新词典及预检状态。

## 存储与同步

| 设置 | GM 存储键 | 已打开页面的同步方式 |
| --- | --- | --- |
| 方向／开关 | `zh-t2s-enabled`、`zh-t2s-lastdir` | 同源 BroadcastChannel；其他站点刷新后读取 |
| 繁体字形 | `zh-t2s-traditional-style` | 同源 BroadcastChannel；其他站点刷新后读取 |
| 自定义词典 | `zh-t2s-dictionary` | 切回前台或打开编辑器时读存储，保存前检查冲突 |
| 白名单 | `zh-t2s-whitelist` | 当前页立即生效，其他页面刷新后读取 |
| 按钮显隐／位置 | `zh-t2s-floatbtn`、`zh-t2s-floatpos` | 当前页立即生效，其他页面刷新后读取 |

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

发布时另建 `chore(release): <version>` 提交，按 SemVer 更新脚本 `@version`、README 版本徽章，并将 Unreleased 内容移至带日期的对应版本条目。发布提交不混入功能代码；Greasy Fork 会从主分支拉取更新。
