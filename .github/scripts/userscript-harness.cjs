'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(resolve(__dirname, '../../zh-t2s.user.js'), 'utf8');

// 仅替换 IIFE 的末尾以取得函数引用；加载整个真实脚本，不复制其功能实现。
// document 保持 loading，不触发网页扫描的启动入口。
function loadUserscript({ dictionary = { t2s: [], s2t: [] }, whitelist = [],
  sitePreferences = {}, state = 't2s', hostname = 'example.test', hasOpenCC = true, floatButton = false } = {}) {
  const storage = new Map([['zh-t2s-dictionary', structuredClone(dictionary)]]);
  storage.set('zh-t2s-whitelist', structuredClone(whitelist));
  storage.set('zh-t2s-site-preferences', structuredClone(sitePreferences));
  storage.set('zh-t2s-enabled', state);
  storage.set('zh-t2s-floatbtn', floatButton);
  const observations = [];
  const mutationCallbacks = new Set();
  const mediaMatches = new Set();
  const timers = new Map();
  const dialogs = [];
  const downloads = [];
  const broadcasts = [];
  const writes = [];
  const confirmations = [];
  let confirmation = true;
  let receiveBroadcast;
  let timerId = 0;
  let writeError = null;
  let readError = null;
  let scans = 0;
  let reloads = 0;

  // 仅支持测试用到的选择器形态：tag、[attr]、tag[attr="value"]。
  function matchesSimple(el, selector) {
    const parsed = /^([a-z]*)(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/i.exec(selector.trim());
    if (!parsed) return false;
    const [, tag, attr, value] = parsed;
    if (tag && el.nodeName !== tag.toUpperCase()) return false;
    if (!attr) return !!tag;
    if (!el.hasAttribute(attr)) return false;
    return value === undefined || el.getAttribute(attr) === value;
  }

  // 模拟编辑器及转换队列使用的 DOM/事件边界；不模拟排版或事件冒泡。
  class Element {
    constructor(tag = 'div') {
      this.nodeName = this.tagName = tag.toUpperCase();
      this.nodeType = 1;
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.children = [];
      this.parentElement = null;
      this.value = this.textContent = '';
      this.isConnected = true;
      // 不模拟排版：高度与滚动位置由用例声明，供视口优先分支读取。
      this.height = 0;
      this.scrollTop = 0;
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: this.height }; }
    // class 与 class 属性保持同一份数据：脚本既用 classList 判定忽略区域，
    // 也用 getAttribute('class') 判断类名变化。
    get className() { return this.attributes.get('class') || ''; }
    set className(value) { this.attributes.set('class', value); }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }
    removeEventListener() {}
    fire(name, event = {}) {
      // 顺序调用，并粗略模拟 stopImmediatePropagation：它阻止同一节点上的后续监听
      const results = [];
      for (const fn of [...(this.listeners.get(name) || [])]) {
        results.push(fn(event));
        if (event.immediatePropagationStopped) break;
      }
      return Promise.all(results);
    }
    click() { return this.fire('click'); }
    appendChild(child) {
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter(node => node !== child);
      }
      this.children.push(child);
      child.parentElement = this;
      return child;
    }
    get classList() {
      const classes = () => this.className.split(/\s+/).filter(Boolean);
      return {
        contains: (name) => classes().includes(name),
        add(name) { if (!this.contains(name)) this.className = [...classes(), name].join(' '); },
        remove(name) { this.className = classes().filter((item) => item !== name).join(' '); },
        toggle(name, force) {
          const has = this.contains(name);
          const next = force === undefined ? !has : !!force;
          if (next && !has) this.add(name);
          if (!next && has) this.remove(name);
          return next;
        }
      };
    }
    closest(selector) {
      assert.equal(selector, '.ignore-opencc');
      for (let el = this; el; el = el.parentElement) {
        if (el.className.split(/\s+/).includes('ignore-opencc')) return el;
      }
      return null;
    }
    contains(node) {
      for (let current = node; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    }
    remove() { this.isConnected = false; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    matches(selector) {
      return selector.split(',').some(part => matchesSimple(this, part));
    }
    querySelectorAll(selector) {
      const result = [];
      const visit = node => {
        for (const child of node.children || []) {
          if (child.nodeType === 1 && child.matches(selector)) result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; return this.fire('close'); }
    attachShadow() { this.shadowRoot = editorRoot(); return this.shadowRoot; }
  }

  function editorRoot() {
    const root = new Element();
    const controls = new Map();
    for (const direction of ['t2s', 's2t']) {
      controls.set('[data-editor="' + direction + '"]', new Element('textarea'));
      const button = new Element('button');
      button.dataset.direction = direction;
      button.setAttribute('aria-pressed', String(direction === 't2s'));
      controls.set('[data-direction="' + direction + '"]', button);
    }
    for (const selector of ['h2', '.status', '[data-preview-input]', '[data-preview-out]', 'input[type="file"]',
      ...['import', 'export', 'cancel', 'save'].map(action => '[data-action="' + action + '"]')]) {
      controls.set(selector, new Element());
    }
    const directions = ['t2s', 's2t'].map(dir => controls.get('[data-direction="' + dir + '"]'));
    root.querySelector = selector => {
      if (selector === '[data-direction][aria-pressed="true"]') {
        return directions.find(button => button.getAttribute('aria-pressed') === 'true');
      }
      assert.ok(controls.has(selector), '未模拟的编辑器选择器：' + selector);
      return controls.get(selector);
    };
    root.querySelectorAll = selector => {
      if (selector === '[data-tool]') return []; // 工具行由 innerHTML 生成，桩不模拟
      assert.equal(selector, '[data-direction]');
      return directions;
    };
    return root;
  }

  const document = new Element();
  document.readyState = 'loading';
  document.documentElement = new Element('html');
  document.createElement = tag => {
    const element = new Element(tag);
    if (tag === 'dialog') dialogs.push(element);
    return element;
  };
  // 样式表只注入一次的逻辑依赖 getElementById；桩返回 null 即可（重复注入对用例无影响）
  document.getElementById = () => null;
  document.createTextNode = text => ({ nodeType: 3, nodeValue: text, isConnected: true });
  document.createTreeWalker = (root, show, filter) => {
    scans++;
    const nodes = [];
    const visit = node => {
      for (const child of node.children || []) {
        const shown = !!(show & (child.nodeType === 3 ? 4 : 1));
        const accepted = shown ? (filter ? filter.acceptNode(child) : 1) : 3;
        if (accepted === 1) nodes.push(child);
        if (accepted !== 2) visit(child);
      }
    };
    visit(root);
    let index = 0;
    return { currentNode: root, nextNode() {
      this.currentNode = nodes[index++] || null;
      return this.currentNode;
    } };
  };
  const sandbox = {
    performance, console: { warn() {} }, document, location: { hostname, reload() { reloads++; } },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: class {
      constructor(callback) { mutationCallbacks.add(callback); }
      observe(...args) { observations.push(args); }
      disconnect() {}
    },
    BroadcastChannel: class {
      addEventListener(name, callback) { receiveBroadcast = callback; }
      postMessage(data) { broadcasts.push(data); }
    },
    GM_getValue: (key, fallback) => {
      if (readError) throw readError;
      return storage.has(key) ? structuredClone(storage.get(key)) : fallback;
    },
    GM_setValue: (key, value) => {
      writes.push({ key, value: structuredClone(value) });
      const error = typeof writeError === 'function' ? writeError(key, value) : writeError;
      if (error) throw error;
      storage.set(key, structuredClone(value));
    },
    GM_registerMenuCommand() { return 1; }, GM_unregisterMenuCommand() {},
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    Blob,
    URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} }
  };
  sandbox.window = {
    // 视口字段由 setViewport 统一写入：假 DOM 没有排版，尺寸与滚动位置没有可推导
    // 的来源，只能由用例声明；默认停在顶部，脚本不会走视口优先分支。
    // 不测 OpenCC 自身的字形字典；用恒等转换器隔离脚本的自定义规则行为。
    OpenCC: hasOpenCC ? { Converter: () => text => text } : undefined,
    confirm(message) { confirmations.push(message); return confirmation; },
    addEventListener() {}, removeEventListener() {}, // 面板会在 window 上挂 resize 监听，桩掉即可
    // 媒体查询：默认全部不匹配，用例用 setMedia 打开需要的偏好
    matchMedia(query) { return { matches: mediaMatches.has(query) }; },
    setTimeout: sandbox.setTimeout
  };
  // 视口状态收在一处，由 setViewport 同时同步 window 字段与 elementFromPoint，
  // 避免用例只改一半（例如设了滚动位置却没指定视口中心的元素）。
  const viewport = { scrollY: 0, width: 1024, height: 768, at: null };
  function applyViewport() {
    sandbox.window.scrollY = viewport.scrollY;
    sandbox.window.innerWidth = viewport.width;
    sandbox.window.innerHeight = viewport.height;
    if (viewport.at) document.elementFromPoint = () => viewport.at;
    else delete document.elementFromPoint;
  }
  applyViewport();

  const marker = '\n})();';
  assert.equal(source.split(marker).length, 2, 'IIFE 结构改变，请更新测试入口。');
  runInNewContext(source.replace(marker, `
    globalThis.api = {
      manageSitePreference, convertSelectedText, setPagePaused, saveSiteDictionary, saveIgnoreRules, syncPageSettings,
      validateIgnoreRules, validateDictionary, buildDictionaryTries, applyDictionary, splitDictionaryLine,
      saveDictionary, mayConvertText, safeConvert, openDictionaryEditor,
      setState, setSitePreference, effectiveState, shouldSkipText, enqueueSubtree, processQueue,
      setPageState, setTraditionalStyle, syncSitePreferenceFromStorage, start,
      renderSitePreferenceControl, renderGlobalPreferenceControl, resetAllSettings,
      validateSettingsBackup, createSettingsBackup, restoreSettingsBackup, openSettingsBackup, openToolDialog, openMoreTools,
      openFloatPanel, closeFloatPanel, setFloatBtnEnabled,
      beginShortcutCapture, applyShortcut, syncShortcutsFromStorage,
      shortcutConfig: () => ({ t2s: shortcutT2S, s2t: shortcutS2T }),
      shortcutState: () => shortcutCapture,
      shortcutMessage: () => shortcutError,
      panelOpen: () => floatPanelOpen,
      preference: () => sitePreference,
      lastPage: () => lastPageDirection,
      snapshot: () => ({ dictionary, dictionaryTries, dictionaryNonHanStart })
    };
  })();`), sandbox, { filename: 'zh-t2s.user.js', timeout: 1000 });

  return {
    api: sandbox.api, storage, timers, downloads, observations, document, broadcasts, writes, confirmations, dialogs,
    // 视口：提供 at（视口中心命中的元素）时页面必须已经离开顶部——文档滚动或
    // 内层容器滚动，否则脚本会跳过视口优先分支，用例会得到"什么都没发生"的假象。
    setViewport({ scrollY = 0, width = 1024, height = 768, at = null } = {}) {
      let scrolled = scrollY > 0;
      for (let node = at; !scrolled && node; node = node.parentElement) scrolled = node.scrollTop > 0;
      assert.ok(!(at && !scrolled), '提供 at 时页面需已滚动（scrollY 或任一祖先 scrollTop）');
      Object.assign(viewport, { scrollY, width, height, at });
      applyViewport();
    },
    // 模拟 shadow 根：复用 Element 的子节点与查询能力，nodeType 设为文档片段。
    createShadowRoot() {
      const root = new Element();
      root.nodeType = 11;
      return root;
    },
    receiveBroadcast(data) { receiveBroadcast({ data }); },
    // 把一批变更记录交给脚本的观察者回调（桩不模拟真实调度）
    emitMutations(mutations) { mutationCallbacks.forEach((callback) => callback(mutations)); },
    setMedia(query, matches) { if (matches) mediaMatches.add(query); else mediaMatches.delete(query); },
    failWrites(error) { writeError = error; },
    failReads(error) { readError = error; },
    setConfirmation(value) { confirmation = value; },
    get scans() { return scans; },
    get reloads() { return reloads; },
    openEditor() {
      sandbox.api.openDictionaryEditor();
      const dialog = dialogs.at(-1);
      const root = dialog.children[0].shadowRoot;
      return { dialog, root, get: selector => root.querySelector(selector) };
    },
    openBackup() {
      sandbox.api.openSettingsBackup();
      const dialog = dialogs.at(-1);
      const root = dialog.children[0].shadowRoot;
      return { dialog, root, get: selector => root.querySelector(selector) };
    },
    runFeedback() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 300) continue;
        timers.delete(id);
        timer.fn();
      }
    }
  };
}

module.exports = { loadUserscript };
