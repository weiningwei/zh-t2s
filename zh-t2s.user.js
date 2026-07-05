// ==UserScript==
// @name         繁简转换 (zh-t2s)
// @name:zh-CN   繁简转换 (zh-t2s)
// @name:zh-TW   繁簡轉換 (zh-t2s)
// @name:en      Traditional-Simplified Chinese Converter (zh-t2s)
// @namespace    https://github.com/weiningwei/zh-t2s
// @version      2.0.7
// @description       基于 OpenCC 在网页繁简中文之间双向转换，覆盖正文/标题/表单等可见文本，支持动态内容与分批处理；默认繁→简，可通过菜单切换为简→繁。
// @description:zh-CN 基于 OpenCC 在网页繁简中文之间双向转换，覆盖正文/标题/表单等可见文本，支持动态内容与分批处理；默认繁→简，可通过菜单切换为简→繁。
// @description:zh-TW 基於 OpenCC 在網頁繁簡中文之間雙向轉換，覆蓋正文/標題/表單等可見文本，支援動態內容與分批處理；預設繁→簡，可透過選單切換為簡→繁。
// @description:en    Bidirectional OpenCC-based conversion between Traditional and Simplified Chinese on web pages. Covers body text, titles, form placeholders, and other visible text. Supports dynamic content and batched processing. Defaults to Traditional→Simplified; menu can switch to Simplified→Traditional.
// @author       weiningwei
// @match        *://*/*
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
  if (!OpenCC || typeof OpenCC.Converter !== 'function') {
    console.warn('[zh-t2s] opencc-js 未加载，繁简转换已禁用（请检查网络或 @require 地址）。');
    return;
  }
  // 字典在 opencc-js 模块级共享，两个 converter 实例仅配置对象，内存增量可忽略
  const converters = {
    t2s: OpenCC.Converter({ from: 't', to: 'cn' }),
    s2t: OpenCC.Converter({ from: 'cn', to: 't' })
  };
  let convert = converters.t2s; // 当前活跃 converter，由 setState 切换

  /** 包裹一层异常保护，避免转换器异常时影响页面或观察者 */
  function safeConvert(text) {
    try { return convert(text); }
    catch (e) { return text; }
  }

  /* ============================================================
   * 2. 配置
   * ============================================================ */
  const IDLE_TIMEOUT = 2000; // requestIdleCallback 兜底超时（ms），保证不会一直不执行
  const CHUNK_SIZE = 300;    // 每个空闲帧最多处理的节点数，防止长时间占用主线程

  // 不转换其内部内容的元素选择器（防止破坏页面功能）
  // - script/style/noscript：代码与样式
  // - textarea/input：用户输入
  // - template：模板内容（未渲染）
  // - xmp/plaintext： legacy 原样显示
  // - iframe/object/embed：外部嵌入内容（多数跨域无法访问）
  // - .ignore-opencc：与 opencc-js HTMLConverter 一致的忽略约定
  const SKIP_SELECTOR =
    'script,style,noscript,textarea,input,template,xmp,plaintext,iframe,object,embed,.ignore-opencc';
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT',
    'TEMPLATE', 'XMP', 'PLAINTEXT', 'IFRAME', 'OBJECT', 'EMBED'
  ]);

  // 需要转换的可见文本属性
  const CONVERTIBLE_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];

  /* ============================================================
   * 2.1 状态模型（持久化到 GM 存储，全局共享）
   * ============================================================
   * 三态：'t2s'（繁→简，默认）| 's2t'（简→繁）| 'off'（关闭）
   * 通过油猴菜单两个互斥项切换：点当前方向项则关闭，点另一方向项则切换。
   * GM_setValue 全局共享，所有站点同方向；BroadcastChannel 同步同源 iframe。
   * 兼容旧版：旧 key 存 '1'/'0'，启动时自动迁移为新三态。
   * ============================================================ */
  const STATE_KEY = 'zh-t2s-enabled'; // 保留 key，避免旧用户偏好丢失
  let state = 't2s'; // 'off' | 't2s' | 's2t'
  try {
    if (typeof GM_getValue === 'function') {
      const saved = GM_getValue(STATE_KEY, 't2s');
      if (saved === 'off') state = 'off';        // 新版关闭
      else if (saved === '0') state = 'off';     // 旧版关闭值
      else if (saved === 's2t') state = 's2t';   // 简→繁
      else state = 't2s';                         // 't2s' / '1' / 未知值 → 默认繁→简
    }
  } catch (e) { /* 读取失败保持默认开启 */ }

  // 跨框架同步（同源 iframe 之间实时同步状态）
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

  function matchShortcut(e, shortcut) {
    // 标准化键名：单字符转大写，多字符（F1-F12、Enter 等）保留
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    return key === shortcut.key &&
           e.ctrlKey === shortcut.ctrl &&
           e.altKey === shortcut.alt &&
           e.shiftKey === shortcut.shift &&
           e.metaKey === shortcut.meta;
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
    if (!el) return false;
    const ed = el.closest('[contenteditable="true"]');
    return !!ed && ed === document.activeElement;
  }

  /** 文本节点是否应被跳过 */
  function shouldSkipText(node) {
    const el = node.parentElement;
    if (el && el.closest(SKIP_SELECTOR)) return true;
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
    const t0 = performance.now();
    const out = safeConvert(text);
    stats.time += performance.now() - t0;              // 累计 OpenCC 耗时
    if (out !== text) {
      stats.chars += text.length;                      // 累计实际改变字符数
      node.nodeValue = out;                             // 写回会触发 characterData 变更
      textState.set(node, out);
    } else {
      textState.set(node, text);                        // 无变化也标记，避免重复计算
    }
  }

  function convertAttributes(el) {
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
      const t0 = performance.now();
      const out = safeConvert(val);
      stats.time += performance.now() - t0;            // 累计 OpenCC 耗时
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
    while (queue.size > 0) {
      if (processed >= CHUNK_SIZE) { scheduleIdle(); return; }
      if (hasDeadline && processed > 0 && deadline.timeRemaining() <= 0) { scheduleIdle(); return; }

      // 取一个节点（O(1)）
      let node;
      for (const n of queue) { node = n; break; }
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
   * 自身写回引发的变更会进入队列，但在 convertTextNode/convertAttributes
   * 中被状态记录判定为“自己上次写入的值”而跳过，因此不会形成死循环。
   * ============================================================ */
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        if (m.target && m.target.nodeType === Node.TEXT_NODE) queue.add(m.target);
      } else if (m.type === 'attributes') {
        if (m.target && m.target.nodeType === Node.ELEMENT_NODE) queue.add(m.target);
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
    } else if (directionChanged) {
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
    } else if (!wasActive && isActive) {
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
    try { if (typeof GM_setValue === 'function') GM_setValue(STATE_KEY, newState); } catch (e) {}
    applyState(oldState, newState);
    refreshMenu();
    if (channel) {
      try { channel.postMessage({ type: 'zh-t2s-state', state: newState }); } catch (e) {}
    }
  }

  // 同源 iframe 之间同步状态
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
    return state === 't2s' ? `✅ 繁→简 [${sc}]` : `⏸ 繁→简 [${sc}]`;
  }
  function menuCaptionS2T() {
    const sc = formatShortcut(shortcutS2T);
    return state === 's2t' ? `✅ 简→繁 [${sc}]` : `⏸ 简→繁 [${sc}]`;
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
  function menuCaptionStatus() {
    if (isWhitelisted) return `⚪ 当前页：已忽略（${currentHost}）`;
    if (state === 'off') return `⚪ 当前页：已关闭`;
    const dir = state === 't2s' ? '繁→简' : '简→繁';
    return `🟢 当前页：${dir} 转换中`;
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
    if (typeof GM_registerMenuCommand !== 'function') return;
    // 先注销所有已注册项
    menuCmdIds.forEach((id) => {
      try { if (typeof GM_unregisterMenuCommand === 'function') GM_unregisterMenuCommand(id); } catch (e) {}
    });
    menuCmdIds = [];
    try {
      menuCmdIds.push(GM_registerMenuCommand(menuCaptionT2S(), () => {
        setState(state === 't2s' ? 'off' : 't2s');
      }));
      menuCmdIds.push(GM_registerMenuCommand(menuCaptionS2T(), () => {
        setState(state === 's2t' ? 'off' : 's2t');
      }));
      // 第三个项：只读统计，点击重新注册以刷新标题
      menuCmdIds.push(GM_registerMenuCommand(menuCaptionStats(), () => {
        refreshMenu();
      }));
      // 第四、五项：快捷键配置
      menuCmdIds.push(GM_registerMenuCommand(menuCaptionConfigT2S(), () => {
        capturingShortcut = 't2s';
        refreshMenu(); // 立即更新标题提示用户按键
      }));
      menuCmdIds.push(GM_registerMenuCommand(menuCaptionConfigS2T(), () => {
        capturingShortcut = 's2t';
        refreshMenu();
      }));
      // 第六项：当前页状态（只读，点击刷新）
      menuCmdIds.push(GM_registerMenuCommand(menuCaptionStatus(), () => {
        refreshMenu();
      }));
      // 第七项：加入/移出白名单
      menuCmdIds.push(GM_registerMenuCommand(menuCaptionToggleWhitelist(), () => {
        toggleWhitelist();
      }));
      // 第八项：清空白名单
      menuCmdIds.push(GM_registerMenuCommand(menuCaptionClearWhitelist(), () => {
        clearWhitelist();
      }));
    } catch (e) {}
  }

  function registerMenu() {
    if (window.top !== window.self) return; // 仅顶层框架注册
    refreshMenu();
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
        key: e.key.length === 1 ? e.key.toUpperCase() : e.key,
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
   * 9. 启动
   * ============================================================ */
  function start() {
    if (state !== 'off' && !isWhitelisted) {   // 白名单中的域名不启动转换
      convert = converters[state];
      // 先开启观察，避免初始扫描期间外部脚本插入的内容被遗漏
      observer.observe(document.documentElement, OBSERVER_OPTIONS);
      // 初始全量扫描（TreeWalker 仅收集引用，转换在空闲帧中分批进行）
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    }
    registerMenu(); // 无论白名单/关闭状态都注册菜单，供用户管理
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start(); // @run-at document-idle 下通常直接走到这里
  }
})();
