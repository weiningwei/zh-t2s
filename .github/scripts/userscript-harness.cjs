'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(resolve(__dirname, '../../zh-t2s.user.js'), 'utf8');

// 仅替换 IIFE 的末尾以取得函数引用；加载整个真实脚本，不复制其功能实现。
// document 保持 loading，不触发网页扫描的启动入口。
function loadUserscript({ dictionary = { t2s: [], s2t: [] }, whitelist = [] } = {}) {
  const storage = new Map([['zh-t2s-dictionary', structuredClone(dictionary)]]);
  storage.set('zh-t2s-whitelist', structuredClone(whitelist));
  const observations = [];
  const timers = new Map();
  const dialogs = [];
  const downloads = [];
  let timerId = 0;
  let writeError = null;
  let scans = 0;

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
      this.className = '';
      this.value = this.textContent = '';
      this.isConnected = true;
    }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(callback);
    }
    removeEventListener() {}
    fire(name, event = {}) {
      return Promise.all((this.listeners.get(name) || []).map(fn => fn(event)));
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
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    matches() { return false; }
    querySelectorAll() { return []; }
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
    for (const selector of ['.status', '[data-preview-input]', '[data-preview-out]', 'input[type="file"]',
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
  document.createTreeWalker = () => { scans++; return { nextNode: () => false }; };
  const sandbox = {
    performance, console: { warn() {} }, document, location: { hostname: 'example.test' },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: class { observe(...args) { observations.push(args); } disconnect() {} },
    GM_getValue: (key, fallback) => storage.has(key) ? structuredClone(storage.get(key)) : fallback,
    GM_setValue: (key, value) => {
      if (writeError) throw writeError;
      storage.set(key, structuredClone(value));
    },
    GM_registerMenuCommand() { return 1; }, GM_unregisterMenuCommand() {},
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    Blob,
    URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} }
  };
  sandbox.window = {
    // 不测 OpenCC 自身的字形字典；用恒等转换器隔离脚本的自定义规则行为。
    OpenCC: { Converter: () => text => text }, confirm: () => true,
    setTimeout: sandbox.setTimeout
  };
  const marker = '\n})();';
  assert.equal(source.split(marker).length, 2, 'IIFE 结构改变，请更新测试入口。');
  runInNewContext(source.replace(marker, `
    globalThis.api = {
      validateDictionary, buildDictionaryTries, applyDictionary, splitDictionaryLine,
      saveDictionary, mayConvertText, safeConvert, openDictionaryEditor,
      setState, toggleWhitelist, effectiveState, shouldSkipText, enqueueSubtree, processQueue,
      snapshot: () => ({ dictionary, dictionaryTries, dictionaryNonHanStart })
    };
  })();`), sandbox, { filename: 'zh-t2s.user.js', timeout: 1000 });

  return {
    api: sandbox.api, storage, timers, downloads, observations, document,
    failWrites(error) { writeError = error; },
    get scans() { return scans; },
    openEditor() {
      sandbox.api.openDictionaryEditor();
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
