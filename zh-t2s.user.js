// ==UserScript==
// @name         繁体中文自动转简体中文 (zh-t2s)
// @name:zh-CN   繁体中文自动转简体中文
// @name:zh-TW   繁體中文自動轉簡體中文
// @namespace    https://github.com/weiningwei/zh-t2s
// @version      1.1.0
// @description       自动将网页中的繁体中文转换为简体中文，覆盖正文、标题、按钮、表单提示等所有可见文本；基于 OpenCC 实现上下文感知的高质量繁简转换，正确处理一对多映射字词；支持动态加载内容，分批处理不阻塞渲染。
// @description:zh-CN 自动将网页中的繁体中文转换为简体中文，覆盖正文、标题、按钮、表单提示等所有可见文本；基于 OpenCC 实现上下文感知的高质量繁简转换，正确处理一对多映射字词；支持动态加载内容，分批处理不阻塞渲染。
// @description:zh-TW 自動將網頁中的繁體中文轉換為簡體中文，覆蓋正文、標題、按鈕、表單提示等所有可見文本；基於 OpenCC 實現上下文感知的高品質繁簡轉換，正確處理一對多映射字詞；支援動態載入內容，分批處理不阻塞渲染。
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
   * 方向选择 from:'t' -> to:'cn'（OpenCC 标准 t2s）：
   *   - 通用繁体输入（兼容台湾 / 香港繁体）
   *   - 仅做字形繁简转换，不改变地区用词（如“軟體”不会变成“软件”）
   *   - 内置 mmseg 短语分词，可依据上下文解决一对多映射
   *     例：乾燥→干燥、乾坤→乾坤、頭髮→头发、發展→发展
   * ============================================================ */
  const OpenCC = window.OpenCC;
  if (!OpenCC || typeof OpenCC.Converter !== 'function') {
    console.warn('[zh-t2s] opencc-js 未加载，繁简转换已禁用（请检查网络或 @require 地址）。');
    return;
  }
  const convert = OpenCC.Converter({ from: 't', to: 'cn' });

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
   * 2.1 开关状态（持久化到 GM 存储，全局共享）
   * ============================================================
   * 默认开启；用户点击油猴菜单项后写入 GM_setValue，所有站点共享。
   * 刷新后保持；BroadcastChannel 用于同步同源 iframe 的实时切换。
   * ============================================================ */
  const STORAGE_KEY = 'zh-t2s-enabled';
  let enabled = true;
  try {
    if (typeof GM_getValue === 'function' && GM_getValue(STORAGE_KEY, '1') === '0') {
      enabled = false;
    }
  } catch (e) { /* 读取失败保持默认开启 */ }

  // 跨框架同步（同源 iframe 之间实时同步开关状态）
  let channel = null;
  try { channel = new BroadcastChannel('zh-t2s'); } catch (e) { channel = null; }

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
  const textState = new WeakMap(); // Text 节点 -> 最近一次写入值
  const attrState = new WeakMap(); // Element   -> Map<属性名, 最近一次写入值>
  // 记录转换前的原始值，关闭开关时用于还原 DOM
  const textOriginal = new WeakMap(); // Text 节点 -> 转换前的原始值
  const attrOriginal = new WeakMap(); // Element   -> Map<属性名, 转换前的原始值>

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

  function convertTextNode(node) {
    const text = node.nodeValue;
    if (!text) return;
    if (textState.get(node) === text) return;          // 自己上次写入的值，无外部改动
    if (!textOriginal.has(node)) textOriginal.set(node, text); // 记录原始值，供关闭时还原
    const out = safeConvert(text);
    if (out !== text) {
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
      if (!origMap.has(attr)) origMap.set(attr, val);   // 记录原始值
      const out = safeConvert(val);
      if (out !== val) el.setAttribute(attr, out);
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

  /** 将 root 子树内所有需要处理的节点入队 */
  function enqueueSubtree(root) {
    if (!root) return;
    const t = root.nodeType;
    if (t === Node.TEXT_NODE) { queue.add(root); return; }
    if (t !== Node.ELEMENT_NODE && t !== Node.DOCUMENT_FRAGMENT_NODE && t !== Node.DOCUMENT_NODE) return;
    if (t === Node.ELEMENT_NODE && SKIP_TAGS.has(root.nodeName)) return; // 整棵子树跳过

    if (t === Node.ELEMENT_NODE) queue.add(root); // 根元素自身属性也需要转换

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // REJECT 会跳过该元素的整个子树（对 script/style 等尤其重要）
            if (SKIP_TAGS.has(node.nodeName)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT; // 接受元素以便后续转换其属性
          }
          // Text 节点
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (shouldSkipText(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    while (walker.nextNode()) queue.add(walker.currentNode);
  }

  /* ============================================================
   * 5. 空闲调度处理
   * ============================================================
   * 使用 requestIdleCallback 分批处理队列，避免一次性遍历大 DOM 造成卡顿。
   * 每帧最多处理 CHUNK_SIZE 个节点，或直到空闲时间耗尽；剩余节点延后到下一帧。
   * ============================================================ */
  const hasRIC = typeof window.requestIdleCallback === 'function';
  let scheduled = false;

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
        if (!shouldSkipText(node)) convertTextNode(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!SKIP_TAGS.has(node.nodeName)) convertAttributes(node);
      }
      processed++;
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
          if (n.nodeType === Node.ELEMENT_NODE) enqueueSubtree(n);
          else if (n.nodeType === Node.TEXT_NODE) queue.add(n);
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

  /** 应用开关状态（不写存储、不广播，仅做实际工作） */
  function applyEnabled(v) {
    if (v) {
      observer.observe(document.documentElement, OBSERVER_OPTIONS);
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    } else {
      observer.disconnect();
      queue.clear();
      scheduled = false;
      restoreAll();
    }
  }

  function setEnabled(v) {
    enabled = v;
    try { if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, v ? '1' : '0'); } catch (e) {}
    applyEnabled(v);
    refreshMenu();
    if (channel) {
      try { channel.postMessage({ type: 'zh-t2s-toggle', enabled: v }); } catch (e) {}
    }
  }

  // 同源 iframe 之间同步开关状态
  if (channel) {
    channel.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'zh-t2s-toggle' && e.data.enabled !== enabled) {
        enabled = e.data.enabled;
        applyEnabled(enabled);
        refreshMenu();
      }
    });
  }

  /* ============================================================
   * 8. 油猴菜单项：点击扩展图标可见，显示当前状态并切换
   * ============================================================
   * 仅顶层框架注册，避免 iframe 重复注册菜单项。
   * Tampermonkey 不支持动态修改菜单项标题，切换时先注销再重新注册。
   * ============================================================ */
  let menuCmdId = null;

  function menuCaption() {
    return enabled ? '繁→简 转换：✅ 已开启（点击关闭）' : '繁→简 转换：⏸ 已关闭（点击开启）';
  }

  function refreshMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (menuCmdId !== null && typeof GM_unregisterMenuCommand === 'function') {
      try { GM_unregisterMenuCommand(menuCmdId); } catch (e) {}
    }
    try {
      menuCmdId = GM_registerMenuCommand(menuCaption(), () => setEnabled(!enabled), 't');
    } catch (e) { menuCmdId = null; }
  }

  function registerMenu() {
    if (window.top !== window.self) return; // 仅顶层框架注册
    refreshMenu();
  }

  /* ============================================================
   * 9. 启动
   * ============================================================ */
  function start() {
    if (enabled) {
      // 先开启观察，避免初始扫描期间外部脚本插入的内容被遗漏
      observer.observe(document.documentElement, OBSERVER_OPTIONS);
      // 初始全量扫描（TreeWalker 仅收集引用，转换在空闲帧中分批进行）
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    }
    registerMenu(); // 无论开关状态都注册菜单，供用户切换
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start(); // @run-at document-idle 下通常直接走到这里
  }
})();
