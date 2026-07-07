// ==UserScript==
// @name         繁简转换 (zh-t2s)
// @name:zh-CN   繁简转换 (zh-t2s)
// @name:zh-TW   繁簡轉換 (zh-t2s)
// @name:en      Traditional-Simplified Chinese Converter (zh-t2s)
// @namespace    https://github.com/weiningwei/zh-t2s
// @version      2.4.3
// @description       基于 OpenCC 在网页繁简中文之间双向转换，覆盖正文/标题/表单等可见文本，支持动态内容与分批处理；默认繁→简，可通过菜单切换为简→繁。
// @description:zh-CN 基于 OpenCC 在网页繁简中文之间双向转换，覆盖正文/标题/表单等可见文本，支持动态内容与分批处理；默认繁→简，可通过菜单切换为简→繁。
// @description:zh-TW 基於 OpenCC 在網頁繁簡中文之間雙向轉換，覆蓋正文/標題/表單等可見文本，支援動態內容與分批處理；預設繁→簡，可透過選單切換為簡→繁。
// @description:en    Bidirectional OpenCC-based conversion between Traditional and Simplified Chinese on web pages. Covers body text, titles, form placeholders, and other visible text. Supports dynamic content and batched processing. Defaults to Traditional→Simplified; menu can switch to Simplified→Traditional.
// @author       weiningwei
// @match        *://*/*
// @noframes
// @require      https://cdn.jsdelivr.net/npm/opencc-js@1.4.0/dist/umd/full.js
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @license      MIT
// @homepageURL  https://github.com/weiningwei/zh-t2s
// @supportURL   https://github.com/weiningwei/zh-t2s/issues
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 1. 依赖检查与转换器初始化
   * ============================================================
   * 使用 opencc-js（纯 JS 版 OpenCC），通过 @require 从 CDN 注入，
   * 字典在构建时已打包进脚本，运行时无需再请求字典文件。
   * 同时构造两个方向的 converter 并缓存：
   *   - t2s: from 't' -> to 'cn'（OpenCC 标准 t2s，繁→简）
   *   - s2t: from 'cn' -> to 't'（OpenCC 标准 s2t，简→繁）
   * 仅做字形繁简转换，不改变地区用词（如"軟體"不会变成"软件"）。
   * 内置 mmseg 短语分词，可依据上下文解决一对多映射
   *   例（t2s）：乾隆 不被误转为 干隆
   *   例（s2t）：发展→發展、头发→頭髮（同一简体字对应多繁体字）
   * ============================================================ */
  const OpenCC = window.OpenCC;
  const hasOpenCC = !!(OpenCC && typeof OpenCC.Converter === 'function');
  if (!hasOpenCC) {
    console.warn('[zh-t2s] opencc-js 未加载，繁简转换已禁用（请检查网络或 @require 地址）。');
  }
  // 字典在 opencc-js 模块级共享，两个 converter 实例仅配置对象，内存增量可忽略
  const converters = hasOpenCC ? {
    t2s: OpenCC.Converter({ from: 't', to: 'cn' }),
    s2t: OpenCC.Converter({ from: 'cn', to: 't' })
  } : {};
  let convert = hasOpenCC ? converters.t2s : null; // 当前活跃 converter，由 setState 切换

  /** 包裹一层异常保护，避免转换器异常时影响页面或观察者 */
  function safeConvert(text) {
    if (!convert) return text;
    try { return convert(text); }
    catch (e) { return text; }
  }

  /* ============================================================
   * 2. 配置
   * ============================================================ */
  const IDLE_TIMEOUT = 2000; // requestIdleCallback 兜底超时（ms），保证不会一直不执行
  const CHUNK_SIZE = 300;    // 每个空闲帧最多处理的节点数，防止长时间占用主线程

  // 不转换其内部内容的元素（防止破坏页面功能）
  // - script/style/noscript：代码与样式
  // - textarea/input：用户输入
  // - template：模板内容（未渲染）
  // - xmp/plaintext： legacy 原样显示
  // - iframe/object/embed：外部嵌入内容（多数跨域无法访问）
  // - .ignore-opencc：与 opencc-js HTMLConverter 一致的忽略约定
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT',
    'TEMPLATE', 'XMP', 'PLAINTEXT', 'IFRAME', 'OBJECT', 'EMBED'
  ]);

  // 需要转换的可见文本属性
  const CONVERTIBLE_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];

  // 浮动状态按钮（页面内可见开关，默认显示，可在油猴菜单关闭）
  // 仅顶层框架创建；按钮自身带 .ignore-opencc，且用内联样式隔离页面 CSS。
  const FLOAT_BTN_KEY = 'zh-t2s-floatbtn';
  const FLOAT_BTN_POS = 'zh-t2s-floatpos'; // 按钮拖动后的位置 { left, top }
  const FLOAT_BTN_DEFAULT = true; // 默认显示；用户可在油猴菜单关闭
  let floatBtnEnabled = FLOAT_BTN_DEFAULT;
  let floatBtnPos = null; // { left, top } 字符串像素值；null 表示用默认右下角

  /* ============================================================
   * 2.1 状态模型（持久化到 GM 存储，全局共享）
   * ============================================================
   * 三态：'t2s'（繁→简，默认）| 's2t'（简→繁）| 'off'（关闭）
   * 通过油猴菜单两个互斥项切换：点当前方向项则关闭，点另一方向项则切换。
   * GM_setValue 全局共享，所有站点同方向；BroadcastChannel 同步同源标签页（@noframes 已禁止 iframe 运行本脚本）。
   * 兼容旧版：旧 key 存 '1'/'0'，启动时自动迁移为新三态。
   * ============================================================ */
  const STATE_KEY = 'zh-t2s-enabled'; // 保留 key，避免旧用户偏好丢失
  const LAST_DIR_KEY = 'zh-t2s-lastdir'; // 关闭前方向，跨刷新沿用
  let state = 't2s'; // 'off' | 't2s' | 's2t'
  let lastDirection = 't2s'; // 关闭前最后使用的方向，再次开启时沿用
  try {
    if (typeof GM_getValue === 'function') {
      const saved = GM_getValue(STATE_KEY, 't2s');
      if (saved === 'off') state = 'off';        // 新版关闭
      else if (saved === '0') state = 'off';     // 旧版关闭值
      else if (saved === 's2t') { state = 's2t'; lastDirection = 's2t'; } // 简→繁
      else state = 't2s';                         // 't2s' / '1' / 未知值 → 默认繁→简
      const ld = GM_getValue(LAST_DIR_KEY, null);
      if (ld === 's2t' || ld === 't2s') lastDirection = ld;
    }
  } catch (e) { /* 读取失败保持默认开启 */ }

  // 跨标签页同步（同源标签页之间实时同步状态；@noframes 已禁止 iframe 运行本脚本）
  let channel = null;
  try { channel = new BroadcastChannel('zh-t2s'); } catch (e) { channel = null; }

  // 会话级统计（页面刷新即重置，不持久化）
  // chars: 实际改变字符数（仅当 OpenCC 输出 ≠ 输入时累加 text.length）
  // time:  OpenCC 调用累计耗时（ms，performance.now 测量）
  let stats = { chars: 0, time: 0 };

  /* ============================================================
   * 2.2 快捷键配置（默认 F8/F9，持久化到 GM 存储）
   * ============================================================
   * F8 = 繁→简 方向开关，F9 = 简→繁 方向开关
   * 通过菜单项"配置快捷键"进入捕获模式，下一次按键即新快捷键
   * 表单聚焦时不响应（input/textarea/contenteditable）
   * ============================================================ */
  const SHORTCUT_KEY_T2S = 'zh-t2s-shortcut-t2s';
  const SHORTCUT_KEY_S2T = 'zh-t2s-shortcut-s2t';
  let shortcutT2S = { key: 'F8', ctrl: false, alt: false, shift: false, meta: false };
  let shortcutS2T = { key: 'F9', ctrl: false, alt: false, shift: false, meta: false };
  let capturingShortcut = null; // null | 't2s' | 's2t'，配置捕获模式标志
  try {
    if (typeof GM_getValue === 'function') {
      const s1 = GM_getValue(SHORTCUT_KEY_T2S, null);
      if (s1 && typeof s1 === 'object' && s1.key) shortcutT2S = s1;
      const s2 = GM_getValue(SHORTCUT_KEY_S2T, null);
      if (s2 && typeof s2 === 'object' && s2.key) shortcutS2T = s2;
    }
  } catch (e) {}

  // 浮动按钮开关与位置（默认开启/右下角，用户可隐藏或拖动）
  try {
    if (typeof GM_getValue === 'function') {
      const fb = GM_getValue(FLOAT_BTN_KEY, null);
      if (typeof fb === 'boolean') floatBtnEnabled = fb;
      const fp = GM_getValue(FLOAT_BTN_POS, null);
      if (fp && typeof fp.left === 'string' && typeof fp.top === 'string') floatBtnPos = fp;
    }
  } catch (e) {}

  /** 标准化键名：单字符转大写，多字符（F1-F12、Enter 等）保留 */
  function normalizeKey(e) {
    return e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }

  function matchShortcut(e, shortcut) {
    const key = normalizeKey(e);
    return key === shortcut.key &&
           e.ctrlKey === shortcut.ctrl &&
           e.altKey === shortcut.alt &&
           e.shiftKey === shortcut.shift &&
           e.metaKey === shortcut.meta;
  }

  function formatShortcut(s) {
    const parts = [];
    if (s.ctrl) parts.push('Ctrl');
    if (s.alt) parts.push('Alt');
    if (s.shift) parts.push('Shift');
    if (s.meta) parts.push('Meta');
    parts.push(s.key);
    return parts.join('+');
  }

  // 浏览器/系统常见快捷键黑名单（Ctrl+字母组合），配置时警告
  const BROWSER_SHORTCUT_CONFLICTS = {
    'Ctrl+S': '保存',
    'Ctrl+W': '关闭标签页',
    'Ctrl+T': '新标签页',
    'Ctrl+N': '新窗口',
    'Ctrl+P': '打印',
    'Ctrl+F': '查找',
    'Ctrl+G': '查找下一个',
    'Ctrl+H': '历史记录',
    'Ctrl+J': '下载列表',
    'Ctrl+D': '加入书签',
    'Ctrl+L': '地址栏',
    'Ctrl+O': '打开文件',
    'Ctrl+Q': '退出',
    'Ctrl+R': '刷新',
    'Ctrl+A': '全选',
    'Ctrl+C': '复制',
    'Ctrl+V': '粘贴',
    'Ctrl+X': '剪切',
    'Ctrl+Z': '撤销',
    'Ctrl+Y': '重做',
    'Ctrl+Tab': '切换标签页',
    'Ctrl+Shift+T': '恢复关闭的标签页',
    'Ctrl+Shift+N': '隐私窗口',
    'Ctrl+Shift+Delete': '清除浏览数据',
    'F1': '帮助',
    'F3': '查找下一个',
    'F5': '刷新',
    'F11': '全屏',
    'F12': '开发者工具'
  };

  let conflictWarning = null; // 非空时显示警告，3 秒后清除

  function detectConflict(sc, otherShortcut) {
    // 与另一方向快捷键冲突
    if (sc.key === otherShortcut.key &&
        sc.ctrl === otherShortcut.ctrl &&
        sc.alt === otherShortcut.alt &&
        sc.shift === otherShortcut.shift &&
        sc.meta === otherShortcut.meta) {
      return '与另一方向快捷键相同';
    }
    // 与浏览器常见快捷键冲突
    const name = formatShortcut(sc);
    if (BROWSER_SHORTCUT_CONFLICTS[name]) {
      return `浏览器「${BROWSER_SHORTCUT_CONFLICTS[name]}」快捷键`;
    }
    return null;
  }

  /* ============================================================
   * 2.3 白名单（不转换名单，按域名匹配）
   * ============================================================
   * 名单中的域名不做任何转换，用于排除特定站点。
   * 数据存 GM_setValue（字符串数组），菜单可加入/移出/清空。
   * ============================================================ */
  const WHITELIST_KEY = 'zh-t2s-whitelist';
  let whitelist = []; // 域名数组，如 ['ptt.cc', 'youtube.com']
  try {
    if (typeof GM_getValue === 'function') {
      const saved = GM_getValue(WHITELIST_KEY, []);
      if (Array.isArray(saved)) whitelist = saved;
    }
  } catch (e) {}

  const currentHost = location.hostname;
  let isWhitelisted = whitelist.includes(currentHost); // let：移出白名单后会重新计算

  function saveWhitelist() {
    try { if (typeof GM_setValue === 'function') GM_setValue(WHITELIST_KEY, whitelist); } catch (e) {}
  }

  /** 当前页实际生效状态（综合白名单、opencc-js 可用性） */
  function effectiveState() {
    if (isWhitelisted || !hasOpenCC) return 'off';
    return state;
  }

  /* ============================================================
   * 3. 状态记录：避免重复转换与自触发死循环
   * ============================================================
   * 转换器写回文本会触发 MutationObserver，若不区分“自己写入的值”与
   * “外部写入的值”，就会形成：写回 -> 触发 -> 再转换 -> 再写回 ... 死循环。
   *
   * 解决办法：记录每个节点最近一次“我们写入的值”。
   *   - 若当前值 === 记录值，说明是我们自己的写入未被改动，跳过。
   *   - 若当前值 !== 记录值，说明外部改动了文本，需要重新转换。
   * ============================================================ */
  let textState = new WeakMap(); // Text 节点 -> 最近一次写入值
  let attrState = new WeakMap(); // Element   -> Map<属性名, 最近一次写入值>
  // 记录转换前的原始值，关闭开关或切换方向时用于还原 DOM
  let textOriginal = new WeakMap(); // Text 节点 -> 转换前的原始值
  let attrOriginal = new WeakMap(); // Element   -> Map<属性名, 转换前的原始值>

  /** 清空所有状态记录（切换方向时必须调用，避免旧方向的状态干扰新方向判断） */
  function clearAllState() {
    textState = new WeakMap();
    attrState = new WeakMap();
    textOriginal = new WeakMap();
    attrOriginal = new WeakMap();
  }

  /** 该文本节点是否正处于用户编辑中的可编辑区域（避免打断输入） */
  function inActiveEditable(node) {
    const el = node.parentElement;
    // 用原生 isContentEditable 替代 el.closest('[contenteditable="true"]')，
    // 避免对每个文本节点都向上遍历祖先链（浏览器内部已高效缓存该判定）。
    return !!el && el.isContentEditable && el === document.activeElement;
  }

  /** 文本节点是否应被跳过 */
  function shouldSkipText(node) {
    const el = node.parentElement;
    if (!el) return false;
    // 快速路径：直接父元素在 SKIP_TAGS 中（script/style/noscript/textarea/xmp/plaintext 的子文本都是直系）
    if (SKIP_TAGS.has(el.nodeName)) return true;
    // 回退：需爬祖先链的稀有情况（.ignore-opencc 类、可编辑元素内）
    if (el.closest('.ignore-opencc')) return true;
    if (inActiveEditable(node)) return true;
    return false;
  }

  // CJK 预检：不含中日韩汉字的文本无需调用 OpenCC，直接跳过。
  // 覆盖基本区(\u4e00-\u9fff)与扩展A区(\u3400-\u4dbf)，足以判定"是否有可转换汉字"。
  // 命中率决定收益：典型网页 30-60% 文本节点为纯 ASCII（URL、数字、英文），可全部跳过。
  const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  function convertTextNode(node) {
    const text = node.nodeValue;
    if (!text) return;
    if (!HAS_CJK.test(text)) return;                    // 预检：无汉字直接跳过
    if (textState.get(node) === text) return;          // 自己上次写入的值，无外部改动
    if (!textOriginal.has(node)) textOriginal.set(node, text); // 记录原始值，供关闭时还原
    const out = safeConvert(text);
    if (out !== text) {
      stats.chars += text.length;                      // 累计实际改变字符数
      node.nodeValue = out;                             // 写回会触发 characterData 变更
      textState.set(node, out);
    } else {
      textState.set(node, text);                        // 无变化也标记，避免重复计算
    }
  }

  function convertAttributes(el) {
    // .ignore-opencc 子树整体跳过（与 shouldSkipText 的约定一致，README 也已声明）
    if (el.closest && el.closest('.ignore-opencc')) return;
    let map = attrState.get(el);
    if (!map) { map = new Map(); attrState.set(el, map); }
    let origMap = attrOriginal.get(el);
    if (!origMap) { origMap = new Map(); attrOriginal.set(el, origMap); }
    for (const attr of CONVERTIBLE_ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const val = el.getAttribute(attr);
      if (val == null) continue;
      if (map.get(attr) === val) continue;              // 自己上次写入的值
      if (!HAS_CJK.test(val)) { map.set(attr, val); continue; } // 预检：无汉字直接跳过
      if (!origMap.has(attr)) origMap.set(attr, val);   // 记录原始值
      const out = safeConvert(val);
      if (out !== val) {
        stats.chars += val.length;                      // 累计实际改变字符数
        el.setAttribute(attr, out);
      }
      map.set(attr, out);
    }
  }

  /* ============================================================
   * 4. 待处理节点队列
   * ============================================================
   * 统一用一个 Set 收集 Text 节点与 Element 节点：
   *   - Text 节点：直接调用 convertTextNode
   *   - Element 节点：调用 convertAttributes（其子树文本由 TreeWalker 单独入队）
   * ============================================================ */
  const queue = new Set();

  /** 将 root 子树内所有需要处理的节点入队
   *  - Text 节点：TreeWalker 遍历收集（跳过 SKIP_TAGS 子树）
   *  - 属性元素：querySelectorAll 一次性查询（浏览器原生 C++ 实现，远快于 JS 逐元素 hasAttribute）
   *    队列规模大幅缩小，去掉 90%+ 无目标属性的 Element 节点
   */
  function enqueueSubtree(root) {
    if (!root) return;
    const t = root.nodeType;
    if (t === Node.TEXT_NODE) { queue.add(root); return; }
    if (t !== Node.ELEMENT_NODE && t !== Node.DOCUMENT_FRAGMENT_NODE && t !== Node.DOCUMENT_NODE) return;
    if (t === Node.ELEMENT_NODE && SKIP_TAGS.has(root.nodeName)) return; // 整棵子树跳过

    // 1) Text 节点：TreeWalker 仅遍历文本，跳过 SKIP_TAGS 子树
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (shouldSkipText(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    while (walker.nextNode()) queue.add(walker.currentNode);

    // 2) 属性元素：原生选择器一次性查询（包含 root 自身若命中）
    const ATTR_SELECTOR = '[placeholder],[title],[alt],[aria-label]';
    try {
      if (t === Node.ELEMENT_NODE && root.matches?.(ATTR_SELECTOR)) queue.add(root);
      root.querySelectorAll?.(ATTR_SELECTOR).forEach((el) => {
        if (!SKIP_TAGS.has(el.nodeName)) queue.add(el);
      });
    } catch (e) { /* querySelectorAll 在某些非标准节点上可能抛错，忽略 */ }
  }

  /* ============================================================
   * 5. 空闲调度处理
   * ============================================================
   * 使用 requestIdleCallback 分批处理队列，避免一次性遍历大 DOM 造成卡顿。
   * 每帧最多处理 CHUNK_SIZE 个节点，或直到空闲时间耗尽；剩余节点延后到下一帧。
   * ============================================================ */
  const hasRIC = typeof window.requestIdleCallback === 'function';
  let scheduled = false;
  let lastMenuRefresh = 0;              // 菜单刷新节流：避免动态内容持续到来时频繁重注册
  const MENU_REFRESH_INTERVAL = 1000;   // 最少间隔 1 秒

  function scheduleIdle() {
    if (scheduled) return;
    scheduled = true;
    if (hasRIC) {
      window.requestIdleCallback(processQueue, { timeout: IDLE_TIMEOUT });
    } else {
      // 不支持 rIC 的环境退化为 setTimeout，仍按 CHUNK_SIZE 分批让出主线程
      window.setTimeout(() => processQueue({ timeRemaining: () => 1 }), 0);
    }
  }

  function processQueue(deadline) {
    scheduled = false;
    const hasDeadline = deadline && typeof deadline.timeRemaining === 'function';
    let processed = 0;
    // 整批统一计时：避免在 convertTextNode/convertAttributes 内对每个节点
    // 各调两次 performance.now()（初始扫描时节点成千上万，开销可观）。
    const t0 = performance.now();
    while (queue.size > 0) {
      if (processed >= CHUNK_SIZE) { scheduleIdle(); return; }
      if (hasDeadline && processed > 0 && deadline.timeRemaining() <= 0) { scheduleIdle(); return; }

      // 取一个节点（O(1)）
      const node = queue.values().next().value;
      if (node === undefined) break;
      queue.delete(node);

      if (!node.isConnected) continue; // 已脱离文档的节点忽略

      if (node.nodeType === Node.TEXT_NODE) {
        // 不再重复调 shouldSkipText：
        // - TreeWalker 收集的节点已在 acceptNode 中过滤
        // - MutationObserver 进来的 characterData 是已存在文本节点，
        //   其父元素跳过状态不会变化（若父元素是 SKIP_TAGS 早就被 REJECT）
        convertTextNode(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!SKIP_TAGS.has(node.nodeName)) convertAttributes(node);
      }
      processed++;
    }
    if (processed > 0) stats.time += performance.now() - t0; // 累计 OpenCC 耗时（整批）
    // 队列处理完毕：刷新菜单让统计项显示最新数据
    // 节流 1 秒，避免动态内容持续到来时频繁注销+重注册菜单项
    if (processed > 0) {
      const now = Date.now();
      if (now - lastMenuRefresh >= MENU_REFRESH_INTERVAL) {
        lastMenuRefresh = now;
        refreshMenu();
      }
    }
  }

  /* ============================================================
   * 6. MutationObserver：监听动态加载 / 异步插入的内容
   * ============================================================
   * - childList + subtree：捕获任意位置新增的节点
   * - characterData：捕获文本内容的改动
   * - attributes（限定为可转换属性）：捕获 placeholder/title 等改动
   *
    * 自身写回引发的变更在 observer 回调中被 textState/attrState 预检过滤，不会入队。
    * ============================================================ */
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        if (m.target && m.target.nodeType === Node.TEXT_NODE) {
          if (textState.get(m.target) === m.target.nodeValue) continue; // 自写回的值，跳过
          queue.add(m.target);
        }
      } else if (m.type === 'attributes') {
        if (m.target && m.target.nodeType === Node.ELEMENT_NODE) {
          const map = attrState.get(m.target);
          if (map && map.get(m.attributeName) === m.target.getAttribute(m.attributeName)) continue; // 自写回的值
          queue.add(m.target);
        }
      } else if (m.type === 'childList') {
        // addedNodes 是各新增子树的根节点，对其整棵子树入队
        m.addedNodes.forEach((n) => {
          if (n.nodeType === Node.ELEMENT_NODE) {
            enqueueSubtree(n);
          } else if (n.nodeType === Node.TEXT_NODE) {
            // 新增的裸文本节点需经过 shouldSkipText 过滤
            // （例如动态插入到 <script> 内的文本，enqueueSubtree 不会处理它）
            if (!shouldSkipText(n)) queue.add(n);
          }
        });
      }
    }
    scheduleIdle();
  });

  /* ============================================================
   * 7. 开关控制：关闭时还原原始文本，开启时重新扫描
   * ============================================================
   * - 关闭：断开 observer -> 清空待处理队列 -> 遍历 DOM 还原原始值
   * - 开启：重新 observe -> 全量扫描入队 -> 空闲帧分批转换
   * - 还原时若发现节点已被外部改动（值 !== 我们上次写入的值），
   *   则不覆盖，避免抹掉页面脚本的最新写入。
   * ============================================================ */
  const OBSERVER_OPTIONS = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: CONVERTIBLE_ATTRS
  };

  function restoreTextNode(node) {
    const orig = textOriginal.get(node);
    if (orig === undefined) return;                 // 该节点从未被转换过
    const last = textState.get(node);
    if (node.nodeValue !== last) return;            // 外部已改动，不覆盖
    if (node.nodeValue !== orig) node.nodeValue = orig;
    textState.delete(node);
    textOriginal.delete(node);
  }

  function restoreAttributes(el) {
    const origMap = attrOriginal.get(el);
    if (!origMap) return;
    const map = attrState.get(el);
    for (const [attr, orig] of origMap) {
      const cur = el.getAttribute(attr);
      if (cur == null) continue;
      if (map && map.get(attr) !== cur) continue;   // 外部已改动，不覆盖
      if (cur !== orig) el.setAttribute(attr, orig);
    }
    attrState.delete(el);
    attrOriginal.delete(el);
  }

  /** 关闭转换时遍历整棵 DOM，把曾被转换过的节点还原为原始值 */
  function restoreAll() {
    const walker = document.createTreeWalker(
      document.documentElement,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (SKIP_TAGS.has(node.nodeName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === Node.TEXT_NODE) restoreTextNode(n);
      else if (n.nodeType === Node.ELEMENT_NODE) restoreAttributes(n);
    }
  }

  /** 应用状态转移（不写存储、不广播，仅做实际工作） */
  function applyState(oldState, newState) {
    const wasActive = oldState !== 'off';
    const isActive = newState !== 'off';
    const directionChanged = wasActive && isActive && oldState !== newState;

    if (!isActive) {
      // 关闭：断开观察、清空队列、还原 DOM、清空状态
      observer.disconnect();
      queue.clear();
      scheduled = false;
      restoreAll();
      clearAllState();
    } else if (directionChanged && hasOpenCC) {
      // 方向切换：必须还原 + 清空 state + 用新方向重扫
      observer.disconnect();
      queue.clear();
      scheduled = false;
      restoreAll();
      clearAllState();
      stats = { chars: 0, time: 0 };                    // 统计清零（还原+重转会让数字失真）
      convert = converters[newState];
      observer.observe(document.documentElement, OBSERVER_OPTIONS);
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    } else if (!wasActive && isActive && hasOpenCC) {
      // 从关闭到开启（同方向）
      convert = converters[newState];
      observer.observe(document.documentElement, OBSERVER_OPTIONS);
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    }
    // off->off / 同状态: 无操作
  }

  function setState(newState) {
    if (state === newState) return; // 防止 BroadcastChannel 回环
    const oldState = state;
    state = newState;
    if (newState !== 'off') lastDirection = newState; // 记住最后使用的方向，供再次开启沿用
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STATE_KEY, newState);
        if (newState !== 'off') GM_setValue(LAST_DIR_KEY, newState);
      }
    } catch (e) {}
    applyState(oldState, newState);
    refreshMenu();
    if (channel) {
      try { channel.postMessage({ type: 'zh-t2s-state', state: newState }); } catch (e) {}
    }
  }

  // 同源标签页之间同步状态（@noframes 已禁止 iframe 运行本脚本）
  if (channel) {
    channel.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'zh-t2s-state' && e.data.state !== state) {
        setState(e.data.state); // setState 开头会判等防回环
      }
    });
  }

  /* ============================================================
   * 8. 油猴菜单项：两个互斥项（繁→简 / 简→繁）
   * ============================================================
   * 仅顶层框架注册，避免 iframe 重复注册菜单项。
   * 点击当前活跃方向项 -> 关闭；点击另一方向项 -> 切换方向并开启。
   * Tampermonkey 不支持动态修改菜单项标题，切换时先注销再重新注册。
   * ============================================================ */
  let menuCmdIds = [];

  function menuCaptionT2S() {
    const sc = formatShortcut(shortcutT2S);
    return effectiveState() === 't2s' ? `✅ 繁→简 [${sc}]` : `⏸ 繁→简 [${sc}]`;
  }
  function menuCaptionS2T() {
    const sc = formatShortcut(shortcutS2T);
    return effectiveState() === 's2t' ? `✅ 简→繁 [${sc}]` : `⏸ 简→繁 [${sc}]`;
  }
  function menuCaptionStats() {
    // 耗时显示：小于 10ms 显示 1 位小数，否则取整
    const t = stats.time < 10 ? stats.time.toFixed(1) : Math.round(stats.time);
    return `📊 ${stats.chars}字 / ${t}ms`;
  }
  function menuCaptionConfigT2S() {
    if (capturingShortcut === 't2s') return '⌨️ 繁→简：按下新键（Esc 取消）';
    if (conflictWarning && conflictWarning.target === 't2s') {
      return `⚠️ ${conflictWarning.msg}，请重新配置`;
    }
    return `⚙️ 繁→简键：${formatShortcut(shortcutT2S)}`;
  }
  function menuCaptionConfigS2T() {
    if (capturingShortcut === 's2t') return '⌨️ 简→繁：按下新键（Esc 取消）';
    if (conflictWarning && conflictWarning.target === 's2t') {
      return `⚠️ ${conflictWarning.msg}，请重新配置`;
    }
    return `⚙️ 简→繁键：${formatShortcut(shortcutS2T)}`;
  }
  function menuCaptionToggleWhitelist() {
    return isWhitelisted
      ? `➖ 移出白名单（${currentHost}）`
      : `➕ 加入白名单（${currentHost}）`;
  }
  function menuCaptionClearWhitelist() {
    return `🗑 清空白名单（共 ${whitelist.length} 项）`;
  }

  /** 加入/移出白名单（当前域名），保存后刷新页面生效 */
  function toggleWhitelist() {
    if (isWhitelisted) {
      whitelist = whitelist.filter((h) => h !== currentHost);
    } else {
      whitelist.push(currentHost);
    }
    saveWhitelist();
    location.reload(); // 白名单变化必须刷新，重新走 start 判断
  }

  /** 清空白名单，保存后刷新页面生效 */
  function clearWhitelist() {
    if (whitelist.length === 0) return;
    whitelist = [];
    saveWhitelist();
    location.reload();
  }

  function refreshMenu() {
    if (typeof GM_registerMenuCommand !== 'function') {
      console.warn('[zh-t2s] GM_registerMenuCommand 不可用，菜单禁用');
      return;
    }
    // 先注销所有已注册项
    menuCmdIds.forEach((id) => {
      try { if (typeof GM_unregisterMenuCommand === 'function') GM_unregisterMenuCommand(id); } catch (e) {}
    });
    menuCmdIds = [];
    function reg(caption, fn) {
      try {
        const id = GM_registerMenuCommand(caption, fn);
        if (id != null) menuCmdIds.push(id);
      } catch (e) {
        console.warn('[zh-t2s] 菜单注册失败:', caption, e);
      }
    }
    // 仅保留顶层方向开关与"浮动按钮隐藏时"的兜底项；快捷键/白名单/统计/重置
    // 已收进浮动按钮的「⚙ 设置」子面板，避免菜单过长（业界弹出层分层做法）。
    reg(menuCaptionT2S(), () => {
      setState(state === 't2s' ? 'off' : 't2s');
    });
    reg(menuCaptionS2T(), () => {
      setState(state === 's2t' ? 'off' : 's2t');
    });
    reg('🔄 重置所有设置', () => {
      resetAllSettings();
    });
    reg(floatBtnEnabled ? '🙈 隐藏浮动按钮' : '👁 显示浮动按钮', () => {
      setFloatBtnEnabled(!floatBtnEnabled);
    });
    // 同步页面内浮动按钮的展示与文案；面板打开时同步重绘
    updateFloatBtn();
    if (floatPanelOpen) renderFloatPanelContent();
  }

  function registerMenu() {
    // @noframes 保证仅顶层执行，此处防御性检查兼容不支持 @noframes 的脚本管理器
    try { if (window.top !== window.self) return; } catch (e) { return; }
    refreshMenu();
    ensureFloatBtn(); // 顶层框架创建浮动按钮（若已启用）
  }

  /* ============================================================
   * 8.1 快捷键监听（捕获阶段，优先于页面脚本）
   * ============================================================
   * - 正常模式：匹配 F8/F9（或用户配置）切换 t2s/s2t 开关
   * - 捕获模式：任意按键作为新快捷键，Esc 取消
   * - 表单聚焦时（input/textarea/contenteditable）不响应正常模式
   * ============================================================ */
  document.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    const inForm = ae && (
      ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
      ae.isContentEditable
    );

    // 捕获模式：任何按键都作为新快捷键（不跳过表单，让用户随处可配置）
    if (capturingShortcut) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        capturingShortcut = null;
        conflictWarning = null;
        refreshMenu();
        return;
      }
      const newShortcut = {
        key: normalizeKey(e),
        ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey
      };
      // 冲突检测：与另一方向相同 / 与浏览器常见快捷键冲突
      const other = capturingShortcut === 't2s' ? shortcutS2T : shortcutT2S;
      const conflict = detectConflict(newShortcut, other);
      if (conflict) {
        // 有冲突：不保存，显示警告 3 秒后清除
        conflictWarning = { target: capturingShortcut, msg: conflict };
        capturingShortcut = null;
        refreshMenu();
        setTimeout(() => {
          conflictWarning = null;
          refreshMenu();
        }, 3000);
        return;
      }
      if (capturingShortcut === 't2s') {
        shortcutT2S = newShortcut;
        try { if (typeof GM_setValue === 'function') GM_setValue(SHORTCUT_KEY_T2S, newShortcut); } catch (e) {}
      } else {
        shortcutS2T = newShortcut;
        try { if (typeof GM_setValue === 'function') GM_setValue(SHORTCUT_KEY_S2T, newShortcut); } catch (e) {}
      }
      capturingShortcut = null;
      conflictWarning = null;
      refreshMenu();
      return;
    }

    // 正常模式：表单聚焦时跳过；白名单页跳过
    if (inForm) return;
    if (isWhitelisted) return;

    if (matchShortcut(e, shortcutT2S)) {
      e.preventDefault();
      setState(state === 't2s' ? 'off' : 't2s');
    } else if (matchShortcut(e, shortcutS2T)) {
      e.preventDefault();
      setState(state === 's2t' ? 'off' : 's2t');
    }
  }, true);

  /* ============================================================
   * 8.3 浮动状态按钮（页面内可见开关，支持在菜单关闭）
   * ============================================================
   * 默认显示于右下角，展示当前转换状态（🟢繁→简 / 🟢简→繁 / ⚪关 / ⚪忽略 / ⚪未加载）。
   * 点击胶囊展开面板：可切换方向、关闭、或隐藏本按钮。
   * 按钮自身带 .ignore-opencc（文本/属性均不被转换），且用内联样式隔离页面 CSS。
   * 仅顶层框架创建（与菜单一致）。
   * ============================================================ */
  let floatBtn = null;        // 主胶囊按钮
  let floatBtnLabel = null;   // 按钮内文案 span
  let floatBtnBadge = null;   // 按钮内状态徽标 span
  let floatPanel = null;      // 展开面板
  let floatPanelOpen = false;
  let floatPanelView = 'main'; // 'main' | 'settings'，面板主视图/设置子视图
  let dragState = null;       // 拖动过程临时状态
  let dragJustMoved = false;  // 刚发生过拖动，吞掉随后的误触 click

  function floatBtnStateText() {
    if (!hasOpenCC) return { icon: '⚪', label: '未加载', on: false };
    if (isWhitelisted) return { icon: '⚪', label: '已忽略', on: false };
    if (state === 'off') return { icon: '⚪', label: '已关闭', on: false };
    return state === 't2s'
      ? { icon: '🟢', label: '繁→简', on: true }
      : { icon: '🟢', label: '简→繁', on: true };
  }

  // 注入浮动 UI 样式表（唯一 class 前缀 zh-t2s-，不与页面样式冲突）。
  // 布局/定位用 class 保证不被页面 CSS 重置；hover/active/动画仅 class 可实现。
  function injectFloatStyles() {
    if (document.getElementById('zh-t2s-float-style')) return;
    const css = [
      '.zh-t2s-floatbtn{position:fixed;z-index:2147483646;display:flex;align-items:center;gap:6px;',
      'padding:7px 13px 7px 8px;border-radius:999px;cursor:grab;user-select:none;-webkit-user-select:none;',
      'touch-action:none;font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;',
      'color:#fff;background:linear-gradient(135deg,#5b9bff,#2f6bff);box-shadow:0 4px 14px rgba(47,107,255,.38);',
      'transition:transform .12s ease,box-shadow .2s ease,background .2s ease,filter .15s ease;}',
      '.zh-t2s-floatbtn:hover{box-shadow:0 6px 22px rgba(47,107,255,.5);filter:brightness(1.04);}',
      '.zh-t2s-floatbtn:active{transform:scale(.95);cursor:grabbing;}',
      '.zh-t2s-floatbtn.off{background:linear-gradient(135deg,#b8c0cc,#8a93a3);box-shadow:0 4px 14px rgba(0,0,0,.2);}',
      '.zh-t2s-badge{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      'font-size:11px;font-weight:700;background:rgba(255,255,255,.22);color:#fff;flex:none;}',
      '.zh-t2s-floatpanel{position:fixed;right:12px;bottom:54px;z-index:2147483646;width:208px;box-sizing:border-box;',
      'background:#fff;color:#1f2329;border:1px solid rgba(0,0,0,.06);border-radius:14px;',
      'box-shadow:0 14px 36px rgba(0,0,0,.2);padding:8px;',
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;',
      'animation:zh-t2s-pop .14s ease;}',
      '@keyframes zh-t2s-pop{from{opacity:0;transform:translateY(8px) scale(.96);}to{opacity:1;transform:none;}}',
      '.zh-t2s-row{padding:8px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;transition:background .12s ease;}',
      '.zh-t2s-row:hover{background:#eef3ff;}',
      '.zh-t2s-row.muted{color:#8a93a3;}',
      '.zh-t2s-row.danger{color:#e5484d;}',
      '.zh-t2s-row.danger:hover{background:#fdeced;}',
      '.zh-t2s-row.primary{background:linear-gradient(135deg,#5b9bff,#2f6bff);color:#fff;font-weight:600;}',
      '.zh-t2s-row.primary:hover{background:linear-gradient(135deg,#6ba6ff,#3f78ff);}',
      '.zh-t2s-seg{flex:1;text-align:center;padding:8px 0;cursor:pointer;border-radius:8px;color:#4a5160;',
      'transition:background .15s ease,color .15s ease;font-size:12px;}',
      '.zh-t2s-seg:hover{background:#f0f4ff;}',
      '.zh-t2s-seg.active{background:linear-gradient(135deg,#5b9bff,#2f6bff);color:#fff;font-weight:600;}',
      '.zh-t2s-divider{height:1px;background:#eef0f3;margin:6px 2px;}',
      '.zh-t2s-header{padding:4px 4px 10px;border-bottom:1px solid #eef0f3;margin-bottom:8px;}',
      '.zh-t2s-header .t{font-weight:600;font-size:13px;color:#1f2329;display:flex;align-items:center;gap:6px;}',
      '.zh-t2s-header .s{font-size:11px;color:#8a93a3;margin-top:3px;}',
      '.zh-t2s-dot{width:8px;height:8px;border-radius:50%;background:#2fbf6b;box-shadow:0 0 0 3px rgba(47,191,107,.18);flex:none;}',
      '.zh-t2s-dot.off{background:#b8c0cc;box-shadow:none;}'
    ].join('\n');
    const style = document.createElement('style');
    style.id = 'zh-t2s-float-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureFloatBtn() {
    if (!floatBtnEnabled) return;
    if (window.top !== window.self) return; // 仅顶层框架
    injectFloatStyles();
    if (floatBtn) { updateFloatBtn(); return; }
    floatBtn = document.createElement('div');
    floatBtn.className = 'ignore-opencc zh-t2s-floatbtn';
    if (floatBtnPos) { // 应用已保存的拖动位置
      floatBtn.style.left = floatBtnPos.left;
      floatBtn.style.top = floatBtnPos.top;
      floatBtn.style.right = 'auto';
      floatBtn.style.bottom = 'auto';
    } else { // 默认右下角
      floatBtn.style.right = '12px';
      floatBtn.style.bottom = '12px';
    }
    floatBtnBadge = document.createElement('span');
    floatBtnBadge.className = 'zh-t2s-badge';
    floatBtnLabel = document.createElement('span');
    floatBtn.appendChild(floatBtnBadge);
    floatBtn.appendChild(floatBtnLabel);
    floatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragJustMoved) { dragJustMoved = false; return; } // 拖动结束的误触 click，吞掉
      // 胶囊点击 = 展开/收起设置面板；面板已展开时再次点击直接关闭
      if (floatPanelOpen) closeFloatPanel();
      else openFloatPanel();
    });
    floatBtn.addEventListener('pointerdown', onFloatPointerDown);
    document.documentElement.appendChild(floatBtn);
    updateFloatBtn();
  }

  function updateFloatBtn() {
    if (!floatBtn) return;
    const s = floatBtnStateText();
    floatBtnLabel.textContent = s.label;
    floatBtnBadge.textContent = s.on ? (state === 's2t' ? '简' : '繁') : '·';
    floatBtn.classList.toggle('off', !s.on);
  }

  function closeFloatPanel() {
    floatPanelOpen = false;
    floatPanelView = 'main';
    if (floatPanel) { floatPanel.remove(); floatPanel = null; }
    document.removeEventListener('click', onDocClickCloseFloat, true);
  }

  function onDocClickCloseFloat(e) {
    if (floatPanel && !floatPanel.contains(e.target) && e.target !== floatBtn) {
      closeFloatPanel();
    }
  }

  // 拖动支持（Pointer Events 统一鼠标/触屏）：移动超 5px 视为拖动，否则视为点击
  function onFloatPointerDown(e) {
    if (e.button != null && e.button !== 0) return; // 仅左键/触摸
    const rect = floatBtn.getBoundingClientRect();
    dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, moved: false };
    document.addEventListener('pointermove', onFloatPointerMove);
    document.addEventListener('pointerup', onFloatPointerUp);
  }

  function onFloatPointerMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      dragState.moved = true;
      closeFloatPanel(); // 拖动时收起面板，避免错位
    }
    const w = floatBtn.offsetWidth, h = floatBtn.offsetHeight;
    let left = Math.max(4, Math.min(dragState.origLeft + dx, window.innerWidth - w - 4));
    let top = Math.max(4, Math.min(dragState.origTop + dy, window.innerHeight - h - 4));
    floatBtn.style.left = left + 'px';
    floatBtn.style.top = top + 'px';
    floatBtn.style.right = 'auto';
    floatBtn.style.bottom = 'auto';
  }

  function onFloatPointerUp() {
    if (!dragState) return;
    const moved = dragState.moved;
    dragState = null;
    document.removeEventListener('pointermove', onFloatPointerMove);
    document.removeEventListener('pointerup', onFloatPointerUp);
    if (moved) {
      dragJustMoved = true; // 阻止随后误触发的 click 切换面板
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(FLOAT_BTN_POS, { left: floatBtn.style.left, top: floatBtn.style.top });
        }
      } catch (e) {}
    }
  }

  function floatPanelRow(label, onClick, opts) {
    opts = opts || {};
    const b = document.createElement('div');
    b.className = 'zh-t2s-row' + (opts.muted ? ' muted' : '') + (opts.danger ? ' danger' : '') + (opts.primary ? ' primary' : '');
    b.textContent = label;
    if (opts.primary) b.style.textAlign = 'center';
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function floatPanelDivider() {
    const d = document.createElement('div');
    d.className = 'zh-t2s-divider';
    return d;
  }

  // 分段控件的一段：active 时高亮蓝色（样式见 .zh-t2s-seg）
  function floatPanelSeg(label, active) {
    const b = document.createElement('div');
    b.className = 'zh-t2s-seg' + (active ? ' active' : '');
    b.textContent = label;
    return b;
  }

  // 主视图页眉（不可点击）：标题 + 状态点 + 统计小字
  function floatPanelHeader() {
    const h = document.createElement('div');
    h.className = 'zh-t2s-header';
    const s = floatBtnStateText();
    const t = document.createElement('div');
    t.className = 't';
    const dot = document.createElement('span');
    dot.className = 'zh-t2s-dot' + (s.on ? '' : ' off');
    t.appendChild(dot);
    t.appendChild(document.createTextNode('繁简转换　' + s.label));
    const stat = document.createElement('div');
    stat.className = 's';
    stat.textContent = menuCaptionStats().replace('📊 ', ''); // 已转 N 字 / M ms
    h.appendChild(t);
    h.appendChild(stat);
    return h;
  }

  // 根据当前视图重绘面板内容（主视图 / 设置子视图）
  function renderFloatPanelContent() {
    if (!floatPanel) return;
    floatPanel.innerHTML = '';
    if (floatPanelView === 'settings') {
      const shead = document.createElement('div');
      shead.className = 'zh-t2s-header';
      const back = floatPanelRow('←', () => { floatPanelView = 'main'; renderFloatPanelContent(); });
      back.style.padding = '4px 10px';
      const stitle = document.createElement('div');
      stitle.textContent = '设置';
      stitle.style.fontWeight = '600';
      shead.appendChild(back);
      shead.appendChild(stitle);
      floatPanel.appendChild(shead);

      floatPanel.appendChild(floatPanelRow(menuCaptionConfigT2S(), () => { capturingShortcut = 't2s'; refreshMenu(); renderFloatPanelContent(); }));
      floatPanel.appendChild(floatPanelRow(menuCaptionConfigS2T(), () => { capturingShortcut = 's2t'; refreshMenu(); renderFloatPanelContent(); }));
      floatPanel.appendChild(floatPanelDivider());
      floatPanel.appendChild(floatPanelRow(menuCaptionToggleWhitelist(), () => { toggleWhitelist(); }));
      floatPanel.appendChild(floatPanelRow(menuCaptionClearWhitelist(), () => { clearWhitelist(); }));
      floatPanel.appendChild(floatPanelDivider());
      floatPanel.appendChild(floatPanelRow('🔄 重置所有设置', () => { resetAllSettings(); }, { danger: true }));
      floatPanel.appendChild(floatPanelRow('🙈 隐藏此按钮', () => { setFloatBtnEnabled(false); }));
      return;
    }
    // 主视图：页眉 + 开关键 + 分段方向开关 + 设置入口
    floatPanel.appendChild(floatPanelHeader());
    const toggleLabel = state === 'off'
      ? '▶ 开启转换（' + (lastDirection === 's2t' ? '简→繁' : '繁→简') + '）'
      : '⏸ 关闭转换';
    floatPanel.appendChild(floatPanelRow(toggleLabel, () => {
      if (state === 'off') setState(lastDirection); // 关闭时沿用上次方向重新开启
      else setState('off');
    }, { primary: true }));
    const seg = document.createElement('div');
    Object.assign(seg.style, {
      display: 'flex', gap: '4px', borderRadius: '10px',
      border: '1px solid #e3e7ee', padding: '3px', marginBottom: '6px', background: '#f6f8fb'
    });
    const s1 = floatPanelSeg('繁→简', state === 't2s');
    s1.addEventListener('click', (e) => { e.stopPropagation(); setState('t2s'); });
    const s2 = floatPanelSeg('简→繁', state === 's2t');
    s2.addEventListener('click', (e) => { e.stopPropagation(); setState('s2t'); });
    seg.appendChild(s1);
    seg.appendChild(s2);
    floatPanel.appendChild(seg);
    floatPanel.appendChild(floatPanelDivider());
    floatPanel.appendChild(floatPanelRow('⚙ 设置', () => { floatPanelView = 'settings'; renderFloatPanelContent(); }));
  }

  function openFloatPanel() {
    floatPanelOpen = true;
    floatPanelView = 'main';
    floatPanel = document.createElement('div');
    floatPanel.className = 'ignore-opencc zh-t2s-floatpanel';
    document.documentElement.appendChild(floatPanel);
    renderFloatPanelContent();
    // 下一轮事件循环再挂全局点击关闭，避免本次点击立即触发
    setTimeout(() => document.addEventListener('click', onDocClickCloseFloat, true), 0);
  }

  function setFloatBtnEnabled(on) {
    floatBtnEnabled = !!on;
    try { if (typeof GM_setValue === 'function') GM_setValue(FLOAT_BTN_KEY, floatBtnEnabled); } catch (e) {}
    if (floatBtnEnabled) {
      ensureFloatBtn();
    } else {
      closeFloatPanel();
      if (floatBtn) { floatBtn.remove(); floatBtn = null; }
    }
    refreshMenu(); // 同步菜单项文案（显示/隐藏）
  }

  /* ============================================================
   * 8.4 重置所有设置
   * ============================================================
   * 清除全部持久化偏好（方向、快捷键、白名单、浮动按钮），恢复默认后刷新页面。
   * 沿用仓库约定（白名单变更亦 reload）以保证 DOM 与状态干净重启。
   * ============================================================ */
  function resetAllSettings() {
    if (!window.confirm('确定重置所有设置？\n将清除方向、快捷键、白名单与浮动按钮偏好，并恢复默认。')) return;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STATE_KEY, 't2s');
        GM_setValue(SHORTCUT_KEY_T2S, { key: 'F8', ctrl: false, alt: false, shift: false, meta: false });
        GM_setValue(SHORTCUT_KEY_S2T, { key: 'F9', ctrl: false, alt: false, shift: false, meta: false });
        GM_setValue(WHITELIST_KEY, []);
        GM_setValue(FLOAT_BTN_KEY, FLOAT_BTN_DEFAULT);
        GM_setValue(FLOAT_BTN_POS, null); // 顺便复位拖动位置，回到默认右下角
      }
    } catch (e) {}
    location.reload();
  }

  /* ============================================================
   * 9. 启动
   * ============================================================ */
  function start() {
    if (state !== 'off' && !isWhitelisted && hasOpenCC) {   // 白名单/无 opencc 时不启动转换
      convert = converters[state];
      // 先开启观察，避免初始扫描期间外部脚本插入的内容被遗漏
      observer.observe(document.documentElement, OBSERVER_OPTIONS);
      // 初始全量扫描（TreeWalker 仅收集引用，转换在空闲帧中分批进行）
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    }
    registerMenu(); // 无论白名单/关闭/无 opencc 状态都注册菜单，供用户管理
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start(); // @run-at document-idle 下通常直接走到这里
  }
})();
