// ==UserScript==
// @name         繁简转换 (zh-t2s)
// @name:zh-CN   繁简转换 (zh-t2s)
// @name:zh-TW   繁簡轉換 (zh-t2s)
// @name:en      Traditional-Simplified Chinese Converter (zh-t2s)
// @namespace    https://github.com/weiningwei/zh-t2s
// @version      2.13.2
// @description       基于 OpenCC 在网页繁简中文之间双向转换，覆盖正文/标题/表单等可见文本，支持动态内容与分批处理；默认繁→简，可通过菜单切换为简→繁。
// @description:zh-CN 基于 OpenCC 在网页繁简中文之间双向转换，覆盖正文/标题/表单等可见文本，支持动态内容与分批处理；默认繁→简，可通过菜单切换为简→繁。
// @description:zh-TW 基於 OpenCC 在網頁繁簡中文之間雙向轉換，覆蓋正文/標題/表單等可見文本，支援動態內容與分批處理；預設繁→簡，可透過選單切換為簡→繁。
// @description:en    Bidirectional OpenCC-based conversion between Traditional and Simplified Chinese on web pages. Covers body text, titles, form placeholders, and other visible text. Supports dynamic content and batched processing. Defaults to Traditional→Simplified; menu can switch to Simplified→Traditional.
// @author       weiningwei
// @match        *://*/*
// @noframes
// @require      https://cdn.jsdelivr.net/npm/opencc-js@1.4.2/dist/umd/full.js
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

  const SCRIPT_VERSION = '2.13.2'; // 发布时与 @version 同步，CI 校验一致性

  /* ============================================================
   * 1. 依赖检查与转换器初始化
   * ============================================================
   * 使用 opencc-js（纯 JS 版 OpenCC），通过 @require 从 CDN 注入，
   * 字典在构建时已打包进脚本，运行时无需再请求字典文件。
   * 繁→简 converter 在启动时构建；简→繁按字形惰性构建并缓存：
   *   - t2s: from 't' -> to 'cn'（OpenCC 标准 t2s，繁→简）
   *   - s2t: from 'cn' -> to 'tw'/'hk'（简→繁，按用户选择输出台湾/香港字形）
   *     目标不用 't'：OpenCC 标准 s2t 偏正体/旧字形，会把 吃 转成 喫、
   *     这里 转成 這裏、刚才 转成 剛纔 等（见 issue #1），逐字比对共 62 字。
   *     'tw'/'hk' 仅叠加地区字形表，不做用词转换（软件 仍为 軟件）。
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
  // 字典在 opencc-js 模块级共享，converter 实例仅配置对象，内存增量可忽略；
  // 但简→繁的地区字形 converter 构建开销较大（每个约 75ms），且关闭状态、
  // 停用的站点与只用繁→简的用户根本用不到，故改为首次使用时惰性构建并缓存
  const converters = hasOpenCC ? {
    t2s: OpenCC.Converter({ from: 't', to: 'cn' }),
    s2t: {}
  } : {};
  let convert = hasOpenCC ? converters.t2s : null; // 当前活跃 converter，由 setState 切换

  /** 按词典 Trie 转换文本：命中片段直接输出，其余片段交给 OpenCC */
  function applyDictionary(text, convertFn, root) {
    const parts = [];
    let plainStart = 0;
    for (let i = 0; i < text.length;) {
      let branch = root;
      let end = i;
      let replacement;
      for (let j = i; j < text.length; j++) {
        const entry = branch.get(text[j]);
        if (!entry) break;
        if (entry.value !== undefined) {
          end = j + 1;
          replacement = entry.value;
        }
        branch = entry.next;
      }
      if (replacement === undefined) { i++; continue; }
      if (plainStart < i) parts.push(convertFn(text.slice(plainStart, i)));
      parts.push(replacement); // 用户结果为最终输出，不再转换或连锁替换
      i = end;
      plainStart = end;
    }
    if (plainStart === 0) return convertFn(text);
    if (plainStart < text.length) parts.push(convertFn(text.slice(plainStart)));
    return parts.join('');
  }

  /** 包裹一层异常保护，避免转换器异常时影响页面或观察者 */
  function safeConvert(text) {
    if (!convert) return text;
    try {
      const root = dictionaryTries[effectiveState()];
      if (!root || root.size === 0) return convert(text);
      return applyDictionary(text, convert, root);
    }
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
  // data-placeholder：部分框架/编辑器用该属性 + CSS content:attr() 渲染占位提示（如 Slate、Quill 定制主题）
  const CONVERTIBLE_ATTRS = ['placeholder', 'data-placeholder', 'title', 'alt', 'aria-label'];

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
  const TRAD_STYLE_KEY = 'zh-t2s-traditional-style'; // 简→繁字形：台湾或香港
  let state = 't2s'; // 'off' | 't2s' | 's2t'
  let lastDirection = 't2s'; // 关闭前最后使用的方向，再次开启时沿用
  let traditionalStyle = 'tw'; // 'tw' | 'hk'，默认台湾字形
  try {
    if (typeof GM_getValue === 'function') {
      const saved = GM_getValue(STATE_KEY, 't2s');
      if (saved === 'off') state = 'off';        // 新版关闭
      else if (saved === '0') state = 'off';     // 旧版关闭值
      else if (saved === 's2t') { state = 's2t'; lastDirection = 's2t'; } // 简→繁
      else state = 't2s';                         // 't2s' / '1' / 未知值 → 默认繁→简
      const ld = GM_getValue(LAST_DIR_KEY, null);
      if (ld === 's2t' || ld === 't2s') lastDirection = ld;
      const savedStyle = GM_getValue(TRAD_STYLE_KEY, 'tw');
      if (savedStyle === 'tw' || savedStyle === 'hk') traditionalStyle = savedStyle;
    }
  } catch (e) { /* 读取失败保持默认开启 */ }

  /** 取当前方向对应的 converter；简→繁按字形惰性构建，首次使用时才付出构建开销 */
  function converterForState(direction) {
    if (!hasOpenCC) return null;
    if (direction !== 's2t') return converters.t2s;
    const style = traditionalStyle === 'hk' ? 'hk' : 'tw';
    return converters.s2t[style] ||
      (converters.s2t[style] = OpenCC.Converter({ from: 'cn', to: style }));
  }

  /* 2.1.1 用户词典：按方向覆盖原文，预编译 Trie，同位置最长词优先。 */
  const DICTIONARY_KEY = 'zh-t2s-dictionary';
  const DICTIONARY_LIMIT = 1000; // 每方向上限，控制持久化与匹配开销
  let dictionary = { t2s: [], s2t: [] };
  let dictionaryTries = { t2s: new Map(), s2t: new Map() };
  // 规则首字符是否为汉字。全部为汉字时，不含汉字的文本不可能命中任何规则，
  // 预检可直接短路，省掉逐字符扫描 Trie 根节点的开销。
  const HAN_START = /^\p{Script=Han}/u;
  let dictionaryNonHanStart = { t2s: false, s2t: false };

  function validateDictionary(data) {
    if (!data || !Array.isArray(data.t2s) || !Array.isArray(data.s2t)) {
      throw new Error('词典须包含 t2s 和 s2t 两组规则。');
    }
    const result = { t2s: [], s2t: [] };
    for (const direction of ['t2s', 's2t']) {
      const label = direction === 't2s' ? '繁→简' : '简→繁';
      if (data[direction].length > DICTIONARY_LIMIT) {
        throw new Error(label + '最多支持 ' + DICTIONARY_LIMIT + ' 条规则。');
      }
      const seen = new Set();
      data[direction].forEach((pair, index) => {
        const at = label + '第 ' + (index + 1) + ' 条';
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some((s) => typeof s !== 'string')) {
          throw new Error(at + '须包含原词和替换词两个字符串。');
        }
        // 首尾空格静默去除（与编辑器内逐行解析的行为一致）
        const source = pair[0].trim();
        const target = pair[1].trim();
        if (!source || !target) throw new Error(at + '的原词和替换词不能为空。');
        if (source.length > 256 || target.length > 1024) {
          throw new Error(at + '超出长度限制：原词最多 256、替换词最多 1024 个字符。');
        }
        if (/[\r\n\t]/.test(source) || /[\r\n\t]/.test(target)) {
          throw new Error(at + '不支持换行或制表符，每条规则占一行。');
        }
        if (source.includes('=>') || target.includes('=>')) {
          throw new Error(at + '的词内不支持「=>」，它只作分隔符。');
        }
        if (seen.has(source)) throw new Error(at + '原词重复：' + source);
        seen.add(source);
        result[direction].push([source, target]);
      });
    }
    return result;
  }

  /** 只构建 Trie 与首字符信息，不读写模块状态（预览等场景复用） */
  function buildDictionaryTries(data) {
    const tries = { t2s: new Map(), s2t: new Map() };
    const nonHanStart = { t2s: false, s2t: false };
    for (const direction of ['t2s', 's2t']) {
      for (const [source, target] of data[direction]) {
        if (!HAN_START.test(source)) nonHanStart[direction] = true;
        let branch = tries[direction];
        for (let i = 0; i < source.length; i++) {
          if (!branch.has(source[i])) branch.set(source[i], { next: new Map() });
          const entry = branch.get(source[i]);
          if (i === source.length - 1) entry.value = target;
          branch = entry.next;
        }
      }
    }
    return { tries, nonHanStart };
  }


  const SITE_DICTIONARY_KEY = 'zh-t2s-site-dictionaries';
  let siteDictionary = { t2s: [], s2t: [] };
  function validateSiteDictionaries(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1000) throw new Error('站点词典格式无效。');
    const result = Object.create(null);
    for (const [host, data] of Object.entries(value)) {
      if (!host || host.length > 253 || !/^[a-z0-9._:\[\]-]+$/i.test(host)) throw new Error('站点词典域名无效。');
      result[host] = validateDictionary(data);
    }
    return result;
  }
  function readSiteDictionary() {
    return validateDictionary(GM_getValue(SITE_DICTIONARY_KEY, {})[location.hostname] || { t2s: [], s2t: [] });
  }
  function mergeDictionaries(global, local) {
    const result = { t2s: [], s2t: [] };
    for (const direction of ['t2s', 's2t']) result[direction] = [...new Map([...global[direction], ...local[direction]]).entries()];
    return result;
  }
  try { if (typeof GM_getValue === 'function') siteDictionary = readSiteDictionary(); } catch (e) { console.warn('[zh-t2s] 站点词典读取失败。', e); }
  function saveSiteDictionary(data) {
    const next = validateDictionary(data);
    const compiled = buildDictionaryTries(mergeDictionaries(dictionary, next));
    const all = validateSiteDictionaries(GM_getValue(SITE_DICTIONARY_KEY, {}));
    all[location.hostname] = next;
    GM_setValue(SITE_DICTIONARY_KEY, all);
    siteDictionary = next;
    dictionaryTries = compiled.tries;
    dictionaryNonHanStart = compiled.nonHanStart;
    if (effectiveState() !== 'off') applyState(effectiveState(), effectiveState(), true);
    refreshMenu();
  }

  /** 构建并切换到新的词典 */
  function compileDictionary(data) {
    const { tries, nonHanStart } = buildDictionaryTries(mergeDictionaries(data, siteDictionary));
    dictionaryNonHanStart = nonHanStart;
    return tries;
  }

  // 规则行分隔符：Tab（表格粘贴）、半角 =>、全角 ＝＞、半角 ->、箭头 →
  const DICTIONARY_SEPARATORS = ['\t', '=>', '＝＞', '＝>', '->', '→'];

  /** 优先识别标准 =>，保证编辑器格式化后的规则可往返；其余分隔符取最靠前者。 */
  function splitDictionaryLine(line) {
    // validateDictionary 禁止词内含 =>，因此它存在时只能作为标准分隔符。
    // 原词中的其他箭头保留为字面内容，避免 JSON 导入后无法保存或导出。
    const canonicalPos = line.indexOf('=>');
    if (canonicalPos >= 0) return [line.slice(0, canonicalPos), line.slice(canonicalPos + 2)];
    let pos = -1;
    let sepLength = 0;
    for (const separator of DICTIONARY_SEPARATORS) {
      const at = line.indexOf(separator);
      if (at < 0) continue;
      if (pos < 0 || at < pos || (at === pos && separator.length > sepLength)) {
        pos = at;
        sepLength = separator.length;
      }
    }
    if (pos < 0) return null;
    return [line.slice(0, pos), line.slice(pos + sepLength)];
  }

  try {
    if (typeof GM_getValue === 'function') {
      dictionary = validateDictionary(GM_getValue(DICTIONARY_KEY, dictionary));
      dictionaryTries = compileDictionary(dictionary);
    }
  } catch (e) { console.warn('[zh-t2s] 自定义词典读取失败，使用空词典。', e); }

  function saveDictionary(data) {
    const next = validateDictionary(data);
    const { tries, nonHanStart } = buildDictionaryTries(mergeDictionaries(next, siteDictionary));
    // 持久化失败时保留草稿与现有配置，不显示成功。
    if (typeof GM_setValue !== 'function') throw new Error('当前环境不支持保存设置。');
    GM_setValue(DICTIONARY_KEY, next);
    dictionary = next;
    dictionaryTries = tries;
    dictionaryNonHanStart = nonHanStart;
    if (effectiveState() !== 'off') applyState(effectiveState(), effectiveState(), true);
    refreshMenu();
  }

  /** 读取存储中的词典；不可用或校验失败时返回 null */
  function readStoredDictionary() {
    try {
      if (typeof GM_getValue !== 'function') return null;
      return validateDictionary(GM_getValue(DICTIONARY_KEY, dictionary));
    } catch (e) {
      console.warn('[zh-t2s] 自定义词典读取失败。', e);
      return null;
    }
  }

  /** 切回前台或打开词典编辑器时，读取最新词典并按需重扫 */
  function syncDictionaryFromStorage() {
    const next = readStoredDictionary();
    let local;
    try { local = readSiteDictionary(); } catch (e) { return; }
    if (!next || (JSON.stringify(next) === JSON.stringify(dictionary) && JSON.stringify(local) === JSON.stringify(siteDictionary))) return;
    siteDictionary = local;
    dictionary = next;
    dictionaryTries = compileDictionary(next);
    if (effectiveState() !== 'off') applyState(effectiveState(), effectiveState(), true);
    refreshMenu();
  }

  // 跨标签页同步（同源标签页之间实时同步状态；@noframes 已禁止 iframe 运行本脚本）
  let channel = null;
  try { channel = new BroadcastChannel('zh-t2s'); } catch (e) { channel = null; }

  // 会话级统计（页面刷新即重置，不持久化）
  // chars: 输出改变的文本/属性原文长度累计（不逐字统计差异）
  // time:  safeConvert 累计耗时，包含词典匹配与 OpenCC 转换（ms）
  let stats = { chars: 0, time: 0 };

  /* ============================================================
   * 2.2 快捷键配置（默认 F8/F9，持久化到 GM 存储）
   * ============================================================
   * F8 = 繁→简 方向开关，F9 = 简→繁 方向开关
   * 兼容读取已保存的快捷键；当前不提供快捷键配置入口
   * 表单聚焦时不响应（input/textarea/contenteditable）
   * ============================================================ */
  const SHORTCUT_KEY_T2S = 'zh-t2s-shortcut-t2s';
  const SHORTCUT_KEY_S2T = 'zh-t2s-shortcut-s2t';
  let shortcutT2S = { key: 'F8', ctrl: false, alt: false, shift: false, meta: false };
  let shortcutS2T = { key: 'F9', ctrl: false, alt: false, shift: false, meta: false };
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

  /* ============================================================
   * 2.3 站点偏好：按 hostname 覆盖全局方向；旧白名单兼容为 off
   * ============================================================ */
  const WHITELIST_KEY = 'zh-t2s-whitelist'; // 仅用于兼容与重置旧数据
  const SITE_PREFERENCES_KEY = 'zh-t2s-site-preferences';
  const currentHost = location.hostname;
  const SITE_MODES = ['follow', 't2s', 's2t', 'off'];
  let sitePreference = 'follow';
  let sitePreferenceError = '';

  function readSitePreferences() {
    const result = Object.create(null);
    if (typeof GM_getValue !== 'function') return result;
    const legacy = GM_getValue(WHITELIST_KEY, []);
    if (Array.isArray(legacy)) {
      for (const host of legacy) if (typeof host === 'string') result[host] = 'off';
    }
    const saved = GM_getValue(SITE_PREFERENCES_KEY, {});
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [host, mode] of Object.entries(saved)) {
        if (SITE_MODES.includes(mode)) result[host] = mode;
      }
    }
    return result;
  }

  try { sitePreference = readSitePreferences()[currentHost] || 'follow'; }
  catch (e) { console.warn('[zh-t2s] 站点偏好读取失败。', e); }
  let lastPageDirection = sitePreference === 's2t' || sitePreference === 't2s'
    ? sitePreference : lastDirection;

  /** 本页未临时暂停时会使用的方向；暂停期间也随设置更新，供关闭后恢复沿用 */
  function pageDirection() {
    return sitePreference === 'follow' ? state : sitePreference;
  }

  /** 当前页实际生效状态；全局修改不会覆盖站点明确选择的方向。 */
  let pagePaused = false;
  function effectiveState() {
    if (pagePaused) return 'off';
    if (!hasOpenCC) return 'off';
    return pageDirection();
  }

  function setSitePreference(mode) {
    if (!SITE_MODES.includes(mode)) return false;
    try {
      if (typeof GM_setValue !== 'function') throw new Error('当前环境不支持保存设置。');
      // 保存前读取，保留其他网站新设置的偏好；显式 follow 覆盖旧白名单。
      const next = readSitePreferences();
      next[currentHost] = mode;
      GM_setValue(SITE_PREFERENCES_KEY, next);
    } catch (e) {
      sitePreferenceError = '保存失败：' + e.message;
      refreshMenu();
      return false;
    }
    const oldState = effectiveState();
    sitePreference = mode;
    const resumed = pageDirection();
    if (resumed !== 'off') lastPageDirection = resumed; // 暂停期间也更新，避免恢复时沿用旧方向
    sitePreferenceError = '';
    applyState(oldState, effectiveState());
    refreshMenu();
    if (channel) {
      try { channel.postMessage({ type: 'zh-t2s-site-preference' }); } catch (e) {}
    }
    return true;
  }

  function syncSitePreferenceFromStorage() {
    try {
      const next = readSitePreferences()[currentHost] || 'follow';
      if (next === sitePreference) return;
      const oldState = effectiveState();
      sitePreference = next;
      const resumed = pageDirection();
      if (resumed !== 'off') lastPageDirection = resumed;
      sitePreferenceError = '';
      applyState(oldState, effectiveState());
      refreshMenu();
    } catch (e) { console.warn('[zh-t2s] 站点偏好同步失败。', e); }
  }

  /** 快捷键和按钮右键沿用当前设置范围，站点覆盖不会改动全局默认。 */

  function setPagePaused(paused) {
    const oldState = effectiveState();
    pagePaused = !!paused;
    applyState(oldState, effectiveState());
    refreshMenu();
  }

  function setPageState(direction) {
    if (pagePaused) setPagePaused(false);
    if (sitePreference === 'follow') setState(direction);
    else setSitePreference(direction);
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


  const IGNORE_RULES_KEY = 'zh-t2s-ignore-rules';
  function validateIgnoreRules(data) {
    if (!Array.isArray(data) || data.length > 20) throw new Error('最多20条忽略规则。');
    if (data.some(rule => typeof rule !== 'string' || rule.length > 80 || !/^(?:[a-zA-Z][a-zA-Z0-9-]*|[.#][a-zA-Z_][a-zA-Z0-9_-]*)$/.test(rule))) throw new Error('每行仅支持标签、.class 或 #id，最长80字符。');
    return [...new Set(data)];
  }
  function validateIgnoreSites(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 1000) throw new Error('忽略规则格式无效。');
    const result = Object.create(null);
    for (const [host, rules] of Object.entries(data)) {
      if (!host || host.length > 253 || !/^[a-z0-9._:\[\]-]+$/i.test(host)) throw new Error('忽略规则域名无效。');
      result[host] = validateIgnoreRules(rules);
    }
    return result;
  }
  let ignoreRules = [];
  let ignoreTags = new Set(), ignoreClasses = new Set(), ignoreIds = new Set();
  function installIgnoreRules(rules) {
    ignoreRules = rules;
    ignoreTags = new Set(rules.filter(s => !/^[.#]/.test(s)).map(s => s.toUpperCase()));
    ignoreClasses = new Set(rules.filter(s => s[0] === '.').map(s => s.slice(1)));
    ignoreIds = new Set(rules.filter(s => s[0] === '#').map(s => s.slice(1)));
  }
  function readIgnoreRules() { return validateIgnoreRules(GM_getValue(IGNORE_RULES_KEY, {})[location.hostname] || []); }
  try { if (typeof GM_getValue === 'function') installIgnoreRules(readIgnoreRules()); } catch (e) { console.warn('[zh-t2s] 忽略规则读取失败。', e); }
  function observerOptions() {
    if (!ignoreRules.length) return OBSERVER_OPTIONS;
    return { ...OBSERVER_OPTIONS, attributeOldValue: true, attributeFilter: [...CONVERTIBLE_ATTRS,
      ...(ignoreClasses.size ? ['class'] : []), ...(ignoreIds.size ? ['id'] : [])] };
  }
  function saveIgnoreRules(rules) {
    const next = validateIgnoreRules(rules);
    const all = validateIgnoreSites(GM_getValue(IGNORE_RULES_KEY, {}));
    all[location.hostname] = next;
    GM_setValue(IGNORE_RULES_KEY, all);
    installIgnoreRules(next);
    if (effectiveState() !== 'off') applyState(effectiveState(), effectiveState(), true);
    refreshMenu();
  }
  function openIgnoreRules() {
    const { root, close, setStatus } = openToolDialog('此网站忽略区域', `
      <p>每行一个标签、.class 或 #id。例如 code、pre、.quote。仅此网站生效，最多20条。不支持组合选择器。</p>
      <textarea data-rules aria-label="忽略规则"></textarea>
      <div class="actions"><button data-save>保存并应用</button><button data-close>取消</button></div>`);
    const field = root.querySelector('[data-rules]');
    root.querySelector('[data-close]').addEventListener('click', close);
    let original;
    try { original = readIgnoreRules(); field.value = original.join('\n'); }
    catch (e) { setStatus(e.message, true); return; }
    root.querySelector('[data-save]').addEventListener('click', () => {
      try {
        if (JSON.stringify(readIgnoreRules()) !== JSON.stringify(original) && !window.confirm('忽略规则已在其他页面更新，覆盖吗？')) return;
        saveIgnoreRules(field.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)); close();
      } catch (e) { setStatus('保存失败：' + e.message, true); }
    });
  }

  /** 实时检查忽略区域，兼容类名变更与节点移动。 */
  function hasIgnoreAncestor(el) {
    return !!el.closest('.ignore-opencc');
  }

  /** 文本与属性共用的元素边界，包含所有被排除的祖先。 */
  function shouldSkipElement(el) {
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      if (SKIP_TAGS.has(ancestor.nodeName)) return true;
      // 标签规则按大写比较：SVG／MathML 等外来元素的 nodeName 保留原本大小写。
      if (ignoreRules.length && ((ignoreTags.size && ignoreTags.has(ancestor.nodeName.toUpperCase())) ||
          ignoreIds.has(ancestor.getAttribute('id')) ||
          (ignoreClasses.size && (ancestor.getAttribute('class') || '').split(/\s+/).some(name => ignoreClasses.has(name))))) return true;
    }
    return hasIgnoreAncestor(el);
  }

  /** 该文本节点是否正处于用户编辑中的可编辑区域（避免打断输入） */
  function inActiveEditable(node) {
    const el = node.parentElement;
    const ae = document.activeElement;
    // 用原生 isContentEditable 快速判定，再用包含关系覆盖 contenteditable 内的嵌套元素。
    return !!el && !!ae && el.isContentEditable &&
      (el === ae || el.contains(ae) || (ae.isContentEditable && ae.contains(el)));
  }

  /** 文本节点是否应被跳过 */
  function shouldSkipText(node) {
    const el = node.parentElement;
    if (!el) return false;
    if (shouldSkipElement(el)) return true;
    if (inActiveEditable(node)) return true;
    return false;
  }

  // 预检：无汉字且不可能命中自定义原词的文本直接跳过。
  // Unicode Han 覆盖扩展区生僻字；有词典时也检查原词首字符，支持非汉字规则。
  // 未配置非汉字开头的规则时，纯 ASCII 文本无需逐字符检查词典。
  const HAS_CJK = /\p{Script=Han}/u;

  function mayConvertText(text) {
    if (HAS_CJK.test(text)) return true;
    const root = dictionaryTries[effectiveState()];
    if (!root || root.size === 0) return false;
    // 规则首字符全是汉字时，无汉字文本不可能命中，免去逐字符扫描
    if (!dictionaryNonHanStart[effectiveState()]) return false;
    for (let i = 0; i < text.length; i++) if (root.has(text[i])) return true;
    return false;
  }

  /** 可复用的 TreeWalker filter，避免每次 enqueueSubtree 新建对象；
   *  预检前置：只收集含汉字或可能命中自定义词典的文本节点。 */
  const TEXT_FILTER = Object.freeze({
    acceptNode(node) {
      if (ignoreRules.length && textOriginal.has(node) && shouldSkipElement(node.parentElement)) return NodeFilter.FILTER_ACCEPT;
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (!mayConvertText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      if (shouldSkipText(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  function convertTextNode(node) {
    const text = node.nodeValue;
    if (!text) return;
    if (textState.get(node) === text) return;          // 自己上次写入的值，无外部改动
    textOriginal.set(node, text); // 非自写回值是页面最新原文，供关闭/修改词典时还原
    const t1 = performance.now();
    const out = safeConvert(text);
    stats.time += performance.now() - t1;
    if (out !== text) {
      stats.chars += text.length;                      // 累计实际改变字符数
      node.nodeValue = out;                             // 写回会触发 characterData 变更
      textState.set(node, out);
    } else {
      textState.set(node, text);                        // 无变化也标记，避免重复计算
    }
  }

  function convertAttributes(el) {
    if (shouldSkipElement(el)) return;
    let map = attrState.get(el);
    if (!map) { map = new Map(); attrState.set(el, map); }
    let origMap = attrOriginal.get(el);
    if (!origMap) { origMap = new Map(); attrOriginal.set(el, origMap); }
    for (const attr of CONVERTIBLE_ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const val = el.getAttribute(attr);
      if (val == null) continue;
      if (map.get(attr) === val) continue;              // 自己上次写入的值
      if (!mayConvertText(val)) { map.set(attr, val); origMap.delete(attr); continue; }
      origMap.set(attr, val);                         // 页面最新原文
      const ta = performance.now();
      const out = safeConvert(val);
      stats.time += performance.now() - ta;
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
   *  - Text 节点：TreeWalker 遍历收集（过滤 SKIP_TAGS 内的文本）
   *  - 属性元素：querySelectorAll 一次性查询（浏览器原生 C++ 实现，远快于 JS 逐元素 hasAttribute）
   *    队列规模大幅缩小，去掉 90%+ 无目标属性的 Element 节点
   */
  function enqueueSubtree(root) {
    if (!root) return;
    const t = root.nodeType;
    if (t === Node.TEXT_NODE) { queue.add(root); return; }
    if (t !== Node.ELEMENT_NODE && t !== Node.DOCUMENT_FRAGMENT_NODE && t !== Node.DOCUMENT_NODE) return;
    if (!ignoreRules.length && t === Node.ELEMENT_NODE && SKIP_TAGS.has(root.nodeName)) return; // 整棵子树跳过

    // 1) Text 节点：TreeWalker 仅遍历文本，由过滤器检查完整祖先边界
    //   TEXT_FILTER 复用了 CJK 预检 + shouldSkipText
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, TEXT_FILTER);
    while (walker.nextNode()) queue.add(walker.currentNode);

    // 2) 属性元素：原生选择器一次性查询（包含 root 自身若命中）
    const ATTR_SELECTOR = '[placeholder],[data-placeholder],[title],[alt],[aria-label]';
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
      const node = queue.values().next().value;
      if (node === undefined) break;
      queue.delete(node);

      if (!node.isConnected) continue; // 已脱离文档的节点忽略

      if (node.nodeType === Node.TEXT_NODE) {
        // 入队后焦点、类名或父节点可能改变，写入前必须重新检查。
        if (ignoreRules.length && node.parentElement && shouldSkipElement(node.parentElement)) restoreTextNode(node);
        else if (!shouldSkipText(node)) convertTextNode(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (ignoreRules.length && shouldSkipElement(node)) restoreAttributes(node);
        else if (!SKIP_TAGS.has(node.nodeName)) convertAttributes(node);
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
   * 5.1 点击触发重扫（兜底「点击展开/加载」后 MutationObserver 漏捕的内容）
   * ============================================================
   * 部分站点（如 B 站折叠评论「点击查看」展开、各类「加载更多」按钮）在用户交互
   * 之后才把内容插入/刷新 DOM，某些框架的更新模式可能让 MutationObserver 漏捕。
   * 这里在 click 事件后做一次去抖的全文档重扫，确保新插入/更新的可见文本被纳入队列。
   * 转换本身幂等（textState 回环守卫会跳过已转换节点），不会死循环或重复开销：
   *   - 队列是 Set，已入队的节点不会重复堆积；
   *   - 已转换节点进入 convertTextNode 后 O(1) 命中 textState 守卫直接返回，不调 OpenCC；
   *   - 被框架回写为原文（繁体）的节点会被重新转换，正好修复「展开后繁体未转」的问题。
   */
  let rescanTimer = null;
  const RESCAN_DELAY = 160; // 等框架完成 DOM 更新后再扫，避免扫描到更新前的临时状态
  function rescanDocument() {
    if (effectiveState() === 'off') return; // 关闭/站点停用/无 opencc 时不扫
    enqueueSubtree(document.documentElement);
    scheduleIdle();
  }
  function scheduleRescan() {
    if (rescanTimer != null) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => { rescanTimer = null; rescanDocument(); }, RESCAN_DELAY);
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
          if (!mayConvertText(m.target.nodeValue)) continue;
          if (shouldSkipText(m.target)) continue;
          queue.add(m.target);
        }
      } else if (m.type === 'attributes') {
        if (m.attributeName === 'class' || m.attributeName === 'id') {
          const values = m.attributeName === 'class' ? ignoreClasses : ignoreIds;
          const matches = value => m.attributeName === 'class'
            ? (value || '').split(/\s+/).some(name => values.has(name)) : values.has(value);
          if (matches(m.oldValue) !== matches(m.target.getAttribute(m.attributeName))) enqueueSubtree(m.target);
          continue;
        }
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
            if (!shouldSkipText(n) || (ignoreRules.length && textOriginal.has(n))) queue.add(n);
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
    // 节点可能在转换后移入排除区域；按写入记录还原，不按当前祖先剪枝。
    const walker = document.createTreeWalker(
      document.documentElement,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
    );
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === Node.TEXT_NODE) restoreTextNode(n);
      else if (n.nodeType === Node.ELEMENT_NODE) restoreAttributes(n);
    }
  }

  /** 应用状态转移（不写存储、不广播，仅做实际工作） */
  function applyState(oldState, newState, conversionChanged = false) {
    if (!hasOpenCC || (oldState === 'off' && newState === 'off')) return;
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
    } else if ((directionChanged || conversionChanged) && hasOpenCC) {
      // 方向、繁体字形或词典改变：还原原文，再按新配置重扫
      observer.disconnect();
      queue.clear();
      scheduled = false;
      restoreAll();
      clearAllState();
      stats = { chars: 0, time: 0 };                    // 统计清零（还原+重转会让数字失真）
      convert = converterForState(newState);
      observer.observe(document.documentElement, observerOptions());
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    } else if (!wasActive && isActive && hasOpenCC) {
      // 从关闭到开启（同方向）
      convert = converterForState(newState);
      observer.observe(document.documentElement, observerOptions());
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    }
    // off->off / 同状态: 无操作
  }

  function setState(newState) {
    if (!['off', 't2s', 's2t'].includes(newState) || state === newState) return;
    const oldState = effectiveState();
    state = newState;
    const resumed = pageDirection();
    if (resumed !== 'off') lastPageDirection = resumed; // 暂停期间也更新，避免恢复时沿用旧方向
    if (newState !== 'off') lastDirection = newState; // 记住最后使用的方向，供再次开启沿用
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STATE_KEY, newState);
        if (newState !== 'off') GM_setValue(LAST_DIR_KEY, newState);
      }
    } catch (e) {}
    applyState(oldState, effectiveState());
    refreshMenu();
    if (channel) {
      try { channel.postMessage({ type: 'zh-t2s-state', state: newState }); } catch (e) {}
    }
  }

  function setTraditionalStyle(newStyle) {
    if ((newStyle !== 'tw' && newStyle !== 'hk') || traditionalStyle === newStyle) return;
    traditionalStyle = newStyle;
    try { if (typeof GM_setValue === 'function') GM_setValue(TRAD_STYLE_KEY, newStyle); } catch (e) {}
    if (effectiveState() === 's2t') {
      applyState(effectiveState(), effectiveState(), true);
    }
    refreshMenu();
    if (channel) {
      try { channel.postMessage({ type: 'zh-t2s-traditional-style', style: newStyle }); } catch (e) {}
    }
  }

  // 同源标签页之间同步状态（@noframes 已禁止 iframe 运行本脚本）
  if (channel) {
    channel.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'zh-t2s-state' && e.data.state !== state) {
        setState(e.data.state); // setState 开头会判等防回环
      } else if (e.data && e.data.type === 'zh-t2s-site-preference') {
        syncSitePreferenceFromStorage();
      } else if (e.data && e.data.type === 'zh-t2s-traditional-style') {
        setTraditionalStyle(e.data.style);
      }
    });
  }


  // 一次读取、比较并安装配置，避免方向/字形/词典同时变化时反复全页重扫。
  function syncPageSettings() {
    if (typeof GM_getValue !== 'function') return;
    try {
      const saved = GM_getValue(STATE_KEY, 't2s');
      const nextState = saved === '0' ? 'off' : saved === '1' ? 't2s' : saved;
      const nextStyle = GM_getValue(TRAD_STYLE_KEY, 'tw');
      const nextSite = readSitePreferences()[currentHost] || 'follow';
      const nextDictionary = readStoredDictionary();
      const nextLocal = readSiteDictionary();
      const nextIgnore = readIgnoreRules();
      if (!['t2s', 's2t', 'off'].includes(nextState) || !['tw', 'hk'].includes(nextStyle) || !nextDictionary) return;
      const dictionaryChanged = JSON.stringify([dictionary, siteDictionary]) !== JSON.stringify([nextDictionary, nextLocal]);
      const ignoreChanged = JSON.stringify(ignoreRules) !== JSON.stringify(nextIgnore);
      const styleChanged = traditionalStyle !== nextStyle;
      const oldState = effectiveState();
      const changed = dictionaryChanged || ignoreChanged || styleChanged || state !== nextState || sitePreference !== nextSite;
      if (!changed) return;
      const compiled = dictionaryChanged ? buildDictionaryTries(mergeDictionaries(nextDictionary, nextLocal)) : null;
      state = nextState; traditionalStyle = nextStyle; sitePreference = nextSite;
      if (nextState !== 'off') lastDirection = nextState;
      const resumed = pageDirection();
      if (resumed !== 'off') lastPageDirection = resumed;
      if (compiled) {
        dictionary = nextDictionary; siteDictionary = nextLocal;
        dictionaryTries = compiled.tries; dictionaryNonHanStart = compiled.nonHanStart;
      }
      if (ignoreChanged) installIgnoreRules(nextIgnore);
      applyState(oldState, effectiveState(), dictionaryChanged || ignoreChanged || (styleChanged && effectiveState() === 's2t'));
      refreshMenu();
    } catch (e) { console.warn('[zh-t2s] 设置同步失败，稍后重试。', e); }
  }

  // 词典不走广播：BroadcastChannel 仅同源，而词典全站生效；
  // 其他页面保存后，本标签在切回前台时读取存储按需同步，只重扫真正用到的标签。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncPageSettings();
    }
  });

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
    return state === 't2s' ? `✅ 全局繁→简 [${sc}]` : `⏸ 全局繁→简 [${sc}]`;
  }
  function menuCaptionS2T() {
    const sc = formatShortcut(shortcutS2T);
    const style = traditionalStyle === 'hk' ? '香港' : '台湾';
    return state === 's2t' ? `✅ 全局简→繁·${style} [${sc}]` : `⏸ 全局简→繁·${style} [${sc}]`;
  }
  function menuCaptionStats() {
    // 耗时显示：小于 10ms 显示 1 位小数，否则取整
    const t = stats.time < 10 ? stats.time.toFixed(1) : Math.round(stats.time);
    return `📊 ${stats.chars}字 / ${t}ms`;
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
    // 菜单仅保留两个方向开关、重置与浮动按钮显隐；其余操作在浮动面板中。
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
   * 匹配 F8/F9（或用户配置）切换 t2s/s2t 开关。
   * 表单聚焦时（input/textarea/contenteditable）不响应。
   * ============================================================ */
  document.addEventListener('keydown', (e) => {
    if ((dictionaryDialog && dictionaryDialog.open) || (toolDialog && toolDialog.open)) return;
    const ae = document.activeElement;
    const inForm = ae && (
      ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
      ae.isContentEditable
    );

    if (inForm) return;

    if (matchShortcut(e, shortcutT2S)) {
      e.preventDefault();
      setPageState(effectiveState() === 't2s' ? 'off' : 't2s');
    } else if (matchShortcut(e, shortcutS2T)) {
      e.preventDefault();
      setPageState(effectiveState() === 's2t' ? 'off' : 's2t');
    }
  }, true);

  // 点击后去抖重扫：兜底「点击查看/展开」「加载更多」等交互后才插入的可见文本。
  // 用冒泡阶段 + 延时，确保 B 站等站点的点击处理逻辑先完成 DOM 更新，再扫描。
  // 不 preventDefault / 不 stopPropagation，绝不干扰页面自身交互。
  document.addEventListener('click', scheduleRescan, false);

  /* ============================================================
   * 8.3 浮动状态按钮（页面内可见开关，支持在菜单关闭）
   * ============================================================
   * 默认显示于右下角，展示当前页实际方向、关闭、此站不转换或引擎未加载。
   * 点击胶囊展开面板：可切换方向、关闭、或隐藏本按钮。
   * 按钮自身带 .ignore-opencc（文本/属性均不被转换），且用内联样式隔离页面 CSS。
   * 仅顶层框架创建（与菜单一致）。
   * ============================================================ */
  let floatBtn = null;        // 主胶囊按钮
  let floatBtnLabel = null;   // 按钮内文案 span
  let floatBtnBadge = null;   // 按钮内状态徽标 span
  let floatPanel = null;      // 展开面板
  let floatPanelOpen = false;
  let dragState = null;       // 拖动过程临时状态
  let dragJustMoved = false;  // 刚发生过拖动，吞掉随后的误触 click

  function floatBtnStateText() {
    if (!hasOpenCC) return { icon: '⚪', label: '未加载', on: false };
    if (pagePaused) return { icon: '⚪', label: '本页已暂停', on: false };
    if (effectiveState() === 'off') return { icon: '⚪', label: sitePreference === 'off' ? '此站不转换' : '已关闭', on: false };
    return effectiveState() === 't2s'
      ? { icon: '🟢', label: '繁→简', on: true }
      : { icon: '🟢', label: '简→繁·' + (traditionalStyle === 'hk' ? '港' : '台'), on: true };
  }

  // 注入浮动 UI 样式表（唯一 class 前缀 zh-t2s-，不与页面样式冲突）。
  // 布局/定位用 class 保证不被页面 CSS 重置；hover/active/动画仅 class 可实现。
  function injectFloatStyles() {
    if (document.getElementById('zh-t2s-float-style')) return;
    const css = [
      '.zh-t2s-floatbtn{position:fixed;z-index:2147483646;display:flex;align-items:center;gap:6px;',
      'margin:0;border:0;padding:7px 13px 7px 8px;border-radius:999px;cursor:grab;user-select:none;-webkit-user-select:none;',
      'touch-action:none;font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;',
      'color:#fff;background:linear-gradient(135deg,#5b9bff,#2f6bff);box-shadow:0 4px 14px rgba(47,107,255,.38);',
      'transition:transform .12s ease,box-shadow .2s ease,background .2s ease,filter .15s ease;}',
      '.zh-t2s-floatbtn:hover{box-shadow:0 6px 22px rgba(47,107,255,.5);filter:brightness(1.04);}',
      '.zh-t2s-floatbtn:active{transform:scale(.95);cursor:grabbing;}',
      '.zh-t2s-floatbtn:focus-visible{outline:2px solid #245fda;outline-offset:3px;}',
      '.zh-t2s-floatbtn.off{background:linear-gradient(135deg,#b8c0cc,#8a93a3);box-shadow:0 4px 14px rgba(0,0,0,.2);}',
      '.zh-t2s-badge{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      'font-size:11px;font-weight:700;background:rgba(255,255,255,.22);color:#fff;flex:none;}',
      '.zh-t2s-floatpanel{position:fixed;z-index:2147483646;width:280px;max-width:calc(100vw - 16px);box-sizing:border-box;',
      'background:#fff;color:#1f2329;border:1px solid #e5e9f0;border-radius:16px;',
      'box-shadow:0 12px 36px rgba(25,40,65,.18);padding:14px;overflow:auto;overscroll-behavior:contain;',
      'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;',
      'text-align:left;color-scheme:light;animation:zh-t2s-pop .14s ease;}',
      '.zh-t2s-floatpanel *{box-sizing:border-box;}',
      '.zh-t2s-floatpanel button,.zh-t2s-floatpanel select{all:unset;box-sizing:border-box;font:inherit;color:inherit;}',
      '.zh-t2s-floatpanel button{cursor:pointer;}',
      '.zh-t2s-floatpanel select{display:block;width:100%;padding:9px 10px;border:1px solid #cdd6e3;',
      'border-radius:8px;background:#fff;appearance:auto;cursor:pointer;line-height:1.4;}',
      '.zh-t2s-floatpanel button:focus-visible,.zh-t2s-floatpanel select:focus-visible{outline:2px solid #2f6bff;outline-offset:2px;}',
      '@keyframes zh-t2s-pop{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
      '.zh-t2s-floatpanel .zh-t2s-row{display:block;width:100%;padding:10px;border-radius:8px;}',
      '.zh-t2s-floatpanel .zh-t2s-row:hover,.zh-t2s-floatpanel .zh-t2s-close:hover{background:#eef3ff;}',
      '.zh-t2s-footer{display:flex;align-items:center;gap:8px;margin-top:6px;}',
      '.zh-t2s-floatpanel .zh-t2s-footer .zh-t2s-row{width:auto;padding:6px 2px;font-size:12px;color:#6b7280;}',
      '.zh-t2s-floatpanel .zh-t2s-footer .danger{color:#b94b50;margin-left:auto;}',
      '.zh-t2s-segments{display:flex;padding:3px;gap:4px;border-radius:9px;background:#eef2f8;}',
      '.zh-t2s-floatpanel .zh-t2s-seg{flex:1;text-align:center;padding:6px;border-radius:6px;color:#4a5160;}',
      '.zh-t2s-floatpanel .zh-t2s-seg:hover{background:#e1e9f6;}',
      '.zh-t2s-floatpanel .zh-t2s-seg.active{background:#fff;color:#245fda;box-shadow:0 1px 4px #182e511a;font-weight:600;}',
      '.zh-t2s-divider{height:1px;background:#edf0f5;margin:12px 0;}',
      '.zh-t2s-header{display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;}',
      '.zh-t2s-header-main{flex:1;min-width:0;}',
      '.zh-t2s-header .t{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-weight:650;font-size:15px;color:#1f2329;}',
      '.zh-t2s-version{font-size:11px;font-weight:400;color:#6b7280;background:#f0f3f8;border-radius:4px;padding:2px 5px;white-space:nowrap;}',
      '.zh-t2s-header .s{display:flex;align-items:center;gap:6px;color:#596579;margin-top:4px;font-size:12px;}',
      '.zh-t2s-floatpanel .zh-t2s-close{display:block;padding:0 5px;border-radius:6px;font-size:20px;line-height:24px;color:#6b7280;}',
      '.zh-t2s-dot{width:7px;height:7px;border-radius:50%;background:#2fbf6b;flex:none;}',
      '.zh-t2s-dot.off{background:#a8b0bd;}',
      '.zh-t2s-site-card{padding:12px;background:#f4f7fc;border:1px solid #e3eaf5;border-radius:11px;}',
      '.zh-t2s-field{display:block;}',
      '.zh-t2s-field-title{display:block;font-weight:600;margin-bottom:7px;}',
      '.zh-t2s-host{display:block;font-size:12px;font-weight:400;color:#6b7280;overflow-wrap:anywhere;margin-top:2px;}',
      '.zh-t2s-hint{font-size:12px;line-height:1.55;color:#6b7280;margin-top:7px;}',
      '.zh-t2s-hint.error{color:#b42318;}',
      '.zh-t2s-style{margin-top:12px;}',
      '.zh-t2s-style .zh-t2s-field-title{font-size:12px;color:#596579;font-weight:400;}'
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
    floatBtn = document.createElement('button');
    floatBtn.type = 'button';
    floatBtn.setAttribute('aria-label', '繁简转换设置');
    floatBtn.setAttribute('aria-expanded', 'false');
    floatBtn.setAttribute('aria-controls', 'zh-t2s-floatpanel');
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
    // 右键快速切换方向，不经面板
    floatBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (effectiveState() === 'off') {
        setPageState(lastPageDirection);
      } else {
        setPageState(effectiveState() === 't2s' ? 's2t' : 't2s');
      }
    });
    floatBtn.addEventListener('pointerdown', onFloatPointerDown);
    document.documentElement.appendChild(floatBtn);
    updateFloatBtn();
  }

  function updateFloatBtn() {
    if (!floatBtn) return;
    const s = floatBtnStateText();
    floatBtnLabel.textContent = s.label;
    floatBtnBadge.textContent = s.on ? (effectiveState() === 's2t' ? '简' : '繁') : '·';
    floatBtn.classList.toggle('off', !s.on);
  }

  function closeFloatPanel() {
    if (!floatPanel) return;
    floatPanelOpen = false;
    floatBtn?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClickCloseFloat, true);
    document.removeEventListener('keydown', onFloatPanelKeydown, true);
    window.removeEventListener('resize', positionFloatPanel);
    const panel = floatPanel;
    floatPanel = null;
    panel.style.transition = 'opacity .12s ease, transform .12s ease';
    panel.style.opacity = '0';
    panel.style.transform = 'translateY(8px) scale(.96)';
    setTimeout(() => { if (panel.parentNode) panel.remove(); }, 120);
  }

  function onFloatPanelKeydown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeFloatPanel();
    floatBtn?.focus({ preventScroll: true });
  }

  function onDocClickCloseFloat(e) {
    // 点击胶囊或其内部子元素（徽标/文案 span）都不视为外部点击，
    // 否则胶囊再次点击会被先关闭、再被自身 handler 重新打开，导致关不掉。
    if (floatPanel && !floatPanel.contains(e.target) && !floatBtn.contains(e.target)) {
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

  function floatPanelRow(label, onClick, opts = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'zh-t2s-row' + (opts.danger ? ' danger' : '');
    if (opts.control) button.setAttribute('data-control', opts.control);
    button.textContent = label;
    button.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return button;
  }

  function floatPanelDivider() {
    const d = document.createElement('div');
    d.className = 'zh-t2s-divider';
    return d;
  }

  // 分段控件的一段：active 时高亮蓝色（样式见 .zh-t2s-seg）
  function floatPanelSeg(label, active) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(active));
    b.className = 'zh-t2s-seg' + (active ? ' active' : '');
    b.textContent = label;
    return b;
  }

  // 页眉先显示当前页状态，统计作为次要信息。
  function floatPanelHeader() {
    const header = document.createElement('div');
    header.className = 'zh-t2s-header';
    const main = document.createElement('div');
    main.className = 'zh-t2s-header-main';
    const title = document.createElement('div');
    title.className = 't';
    title.textContent = '繁简转换';
    const version = document.createElement('span');
    version.className = 'zh-t2s-version';
    version.textContent = 'v' + SCRIPT_VERSION;
    version.setAttribute('aria-label', '当前版本 ' + SCRIPT_VERSION);
    title.appendChild(version);
    const status = document.createElement('div');
    status.className = 's';
    const current = floatBtnStateText();
    const dot = document.createElement('span');
    dot.className = 'zh-t2s-dot' + (current.on ? '' : ' off');
    status.appendChild(dot);
    status.appendChild(document.createTextNode(current.label + ' · ' + menuCaptionStats().replace('📊 ', '')));
    main.appendChild(title);
    main.appendChild(status);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'zh-t2s-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭设置面板');
    close.setAttribute('data-control', 'close');
    close.addEventListener('click', () => {
      closeFloatPanel();
      floatBtn?.focus({ preventScroll: true });
    });
    header.appendChild(main);
    header.appendChild(close);
    return header;
  }

  // 低频工具共用模态外壳；调用时才创建 DOM，内容必须为代码内静态模板。
  let toolDialog = null;
  function openToolDialog(title, contentHTML) {
    closeFloatPanel();
    if (toolDialog) toolDialog.close();
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'ignore-opencc';
    dialog.setAttribute('aria-label', title);
    Object.assign(dialog.style, {
      position: 'fixed', inset: '0', margin: 'auto', width: '560px',
      maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)',
      boxSizing: 'border-box', padding: '0', border: '1px solid #dce2eb', borderRadius: '14px',
      background: '#fff', color: '#1f2329', boxShadow: '0 16px 64px #0005', overflow: 'auto'
    });
    const host = document.createElement('div');
    dialog.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      *{box-sizing:border-box}[hidden]{display:none!important}
      .body{padding:20px;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#1f2329;background:#fff}
      h2{font-size:18px;margin:0 0 8px}p{margin:8px 0;color:#596579}.hint{font-size:12px}
      button,input,textarea,select{font:inherit;color:#263449}
      button,select{border:1px solid #d4dce8;border-radius:8px;padding:7px 12px;background:#f6f8fb}
      button{cursor:pointer}button:disabled{opacity:.5;cursor:default}.primary{background:#2f6bff;color:white;border-color:#2f6bff}
      button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #2f6bff;outline-offset:2px}
      textarea,input[type="text"]{display:block;width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:8px;background:white}
      textarea{min-height:120px;resize:vertical}.actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:16px}
      .status{min-height:24px;color:#596579;white-space:pre-wrap;overflow-wrap:anywhere}.status[data-error="true"]{color:#b42318}
    </style><div class="body"><h2></h2>${contentHTML}<div class="status" role="status" aria-live="polite"></div></div>`;
    root.querySelector('h2').textContent = title;
    const status = root.querySelector('.status');
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); dialog.close(); });
    dialog.addEventListener('close', () => {
      if (toolDialog === dialog) toolDialog = null;
      dialog.remove();
      const target = previousFocus?.isConnected ? previousFocus : floatBtn;
      target?.focus({ preventScroll: true });
    });
    document.documentElement.appendChild(dialog);
    toolDialog = dialog;
    dialog.showModal();
    return { dialog, root, close: () => dialog.close(), setStatus(message, error = false) {
      status.textContent = message;
      status.dataset.error = String(error);
    } };
  }


  function manageSitePreference(host, mode) {
    if (!Object.hasOwn(readSitePreferences(), host) || !SITE_MODES.includes(mode)) throw new Error('网站或方向无效。');
    const next = readSitePreferences();
    next[host] = mode; // 显式 follow 解除旧白名单。
    GM_setValue(SITE_PREFERENCES_KEY, next);
    syncSitePreferenceFromStorage();
    if (channel) channel.postMessage({ type: 'zh-t2s-site-preference' });
  }

  function openSiteManager() {
    const { root, close, setStatus } = openToolDialog('站点偏好管理', `
      <p>搜索并修改已配置网站。选择“跟随全局”解除单独偏好，立即保存。</p>
      <input type="text" aria-label="搜索网站" data-search>
      <div data-list></div><div class="actions"><button data-close>关闭</button></div>`);
    const search = root.querySelector('[data-search]');
    const list = root.querySelector('[data-list]');
    function render() {
      list.textContent = '';
      try {
        const rows = Object.entries(readSitePreferences()).filter(([host, mode]) => mode !== 'follow' && host.includes(search.value.trim().toLowerCase()));
        for (const [host, mode] of rows.slice(0, 100)) {
          const row = preferenceSelect(host, [['follow', '跟随全局'], ['t2s', '繁→简'], ['s2t', '简→繁'], ['off', '不转换']], mode, value => {
            try { manageSitePreference(host, value); render(); setStatus('已保存：' + host); }
            catch (e) { setStatus('保存失败：' + e.message, true); }
          }, 'managed-site');
          const label = document.createElement('label');
          const caption = document.createElement('div');
          caption.textContent = host;
          label.appendChild(caption); label.appendChild(row);
          list.appendChild(label);
        }
        setStatus('匹配 ' + rows.length + ' 个网站，最多显示 100 项，请搜索缩小范围。');
      } catch (e) { setStatus(e.message, true); }
    }
    search.addEventListener('input', render);
    root.querySelector('[data-close]').addEventListener('click', close);
    render();
  }


  let selectionSnapshot = '';
  function convertSelectedText(text, direction) {
    if (text.length > 20000) throw new Error('最多转换 20000 个字符。');
    if (!hasOpenCC) throw new Error('转换引擎未加载。');
    if (!['t2s', 's2t'].includes(direction)) throw new Error('转换方向无效。');
    return applyDictionary(text, converterForState(direction), dictionaryTries[direction]);
  }
  function openSelectionTool() {
    const text = selectionSnapshot;
    const { root, close, setStatus } = openToolDialog('选中文字转换', `
      <p>转换当前选中的显示文本，也可粘贴文字。沿用当前字形与词典。最多20000字符。</p>
      <textarea data-source aria-label="待转换文字" maxlength="20000"></textarea>
      <div class="actions"><button data-dir="t2s">繁→简</button><button data-dir="s2t">简→繁</button></div>
      <textarea data-result aria-label="转换结果" readonly></textarea>
      <div class="actions"><button data-copy>复制结果</button><button data-close>关闭</button></div>`);
    const source = root.querySelector('[data-source]');
    const output = root.querySelector('[data-result]');
    source.value = text.length <= 20000 ? text : '';
    if (text.length > 20000) setStatus('选区超过20000字符，请缩小范围或粘贴部分文字。', true);
    for (const button of root.querySelectorAll('[data-dir]')) button.addEventListener('click', () => {
      try { output.value = convertSelectedText(source.value, button.dataset.dir); setStatus('转换完成。'); }
      catch (e) { setStatus(e.message, true); }
    });
    root.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        if (!window.navigator?.clipboard?.writeText) throw new Error('请手动复制已选中的结果。');
        await window.navigator.clipboard.writeText(output.value); setStatus('已复制结果。');
      } catch (e) { output.focus(); output.select(); setStatus(e.message, true); }
    });
    root.querySelector('[data-close]').addEventListener('click', close);
  }

  const SETTINGS_BACKUP_LIMIT = 16 * 1024 * 1024;

  /** 备份只接受已知字段，复制后再使用，不将任意 JSON 键写入 GM 存储。 */
  function validateSettingsBackup(data) {
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
    if (!record(data) || data.format !== 'zh-t2s-settings' || data.schemaVersion !== 1 || !record(data.settings)) {
      throw new Error('不是受支持的 zh-t2s 设置备份（schemaVersion 必须为 1）。');
    }
    const settings = data.settings;
    if (!['t2s', 's2t', 'off'].includes(settings.state) || !['t2s', 's2t'].includes(settings.lastDirection) ||
        !['tw', 'hk'].includes(settings.traditionalStyle)) throw new Error('方向或繁体字形无效。');
    if (!record(settings.shortcuts)) throw new Error('快捷键设置无效。');
    const shortcuts = {};
    for (const direction of ['t2s', 's2t']) {
      const shortcut = settings.shortcuts[direction];
      if (!record(shortcut) || typeof shortcut.key !== 'string' || !shortcut.key.length || shortcut.key.length > 32 ||
          /[\u0000-\u001f\u007f]/.test(shortcut.key) ||
          ['ctrl', 'alt', 'shift', 'meta'].some(key => typeof shortcut[key] !== 'boolean')) {
        throw new Error('快捷键设置无效：' + direction + '。');
      }
      shortcuts[direction] = { key: shortcut.key, ctrl: shortcut.ctrl, alt: shortcut.alt, shift: shortcut.shift, meta: shortcut.meta };
    }
    if (!record(settings.sitePreferences) || Object.keys(settings.sitePreferences).length > 10000) {
      throw new Error('站点偏好无效或超过 10000 个网站。');
    }
    const sites = Object.create(null);
    for (const [host, mode] of Object.entries(settings.sitePreferences)) {
      if (!host || host.length > 253 || !/^(?:[a-z0-9._-]+|\[[a-f0-9:.]+\])$/i.test(host) || !SITE_MODES.includes(mode)) {
        throw new Error('站点偏好包含无效域名或方向。');
      }
      sites[host] = mode;
    }
    const button = settings.floatButton;
    if (!record(button) || typeof button.enabled !== 'boolean' ||
        (button.position !== null && (!record(button.position) || ['left', 'top'].some(key =>
          typeof button.position[key] !== 'string' || !/^-?\d+(?:\.\d+)?px$/.test(button.position[key]) ||
          !Number.isFinite(parseFloat(button.position[key])) || Math.abs(parseFloat(button.position[key])) > 1000000)))) {
      throw new Error('浮动按钮设置无效。');
    }
    return { format: 'zh-t2s-settings', schemaVersion: 1, settings: {
      state: settings.state, lastDirection: settings.lastDirection, traditionalStyle: settings.traditionalStyle,
      shortcuts, sitePreferences: sites, dictionary: validateDictionary(settings.dictionary), siteDictionaries: validateSiteDictionaries(settings.siteDictionaries || {}), ignoreSites: validateIgnoreSites(settings.ignoreSites || {}),
      floatButton: { enabled: button.enabled, position: button.position === null ? null : {
        left: button.position.left, top: button.position.top
      } }
    } };
  }

  function createSettingsBackup() {
    if (typeof GM_getValue !== 'function') throw new Error('当前环境不支持读取设置。');
    const savedState = GM_getValue(STATE_KEY, 't2s');
    const direction = savedState === '0' ? 'off' : savedState === '1' ? 't2s' : savedState;
    return validateSettingsBackup({ format: 'zh-t2s-settings', schemaVersion: 1, settings: {
      state: direction, lastDirection: GM_getValue(LAST_DIR_KEY, direction === 's2t' ? 's2t' : 't2s'),
      traditionalStyle: GM_getValue(TRAD_STYLE_KEY, 'tw'),
      shortcuts: {
        t2s: GM_getValue(SHORTCUT_KEY_T2S, { key: 'F8', ctrl: false, alt: false, shift: false, meta: false }),
        s2t: GM_getValue(SHORTCUT_KEY_S2T, { key: 'F9', ctrl: false, alt: false, shift: false, meta: false })
      },
      ignoreSites: GM_getValue(IGNORE_RULES_KEY, {}), siteDictionaries: GM_getValue(SITE_DICTIONARY_KEY, {}), sitePreferences: readSitePreferences(), dictionary: GM_getValue(DICTIONARY_KEY, { t2s: [], s2t: [] }),
      floatButton: { enabled: GM_getValue(FLOAT_BTN_KEY, FLOAT_BTN_DEFAULT), position: GM_getValue(FLOAT_BTN_POS, null) }
    } });
  }

  /** 多键写入先保存原值；失败尝试回滚，成功只刷新一次，不逐项还原、重扫 DOM。 */
  function restoreSettingsBackup(data) {
    const settings = validateSettingsBackup(data).settings;
    if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') throw new Error('当前环境不支持保存设置。');
    const entries = [
      [STATE_KEY, settings.state, 't2s'], [LAST_DIR_KEY, settings.lastDirection, 't2s'],
      [TRAD_STYLE_KEY, settings.traditionalStyle, 'tw'],
      [SHORTCUT_KEY_T2S, settings.shortcuts.t2s, { key: 'F8', ctrl: false, alt: false, shift: false, meta: false }],
      [SHORTCUT_KEY_S2T, settings.shortcuts.s2t, { key: 'F9', ctrl: false, alt: false, shift: false, meta: false }],
      [SITE_PREFERENCES_KEY, settings.sitePreferences, {}], [WHITELIST_KEY, [], []],
      [DICTIONARY_KEY, settings.dictionary, { t2s: [], s2t: [] }],
      [SITE_DICTIONARY_KEY, settings.siteDictionaries, {}],
      [IGNORE_RULES_KEY, settings.ignoreSites, {}],
      [FLOAT_BTN_KEY, settings.floatButton.enabled, FLOAT_BTN_DEFAULT], [FLOAT_BTN_POS, settings.floatButton.position, null]
    ];
    const previous = entries.map(([key, , fallback]) => GM_getValue(key, fallback));
    let attempted = 0;
    try {
      for (let index = 0; index < entries.length; index++) {
        attempted = index + 1;
        GM_setValue(entries[index][0], entries[index][1]);
      }
    } catch (error) {
      let rollbackFailed = false;
      for (let index = attempted - 1; index >= 0; index--) {
        try { GM_setValue(entries[index][0], previous[index]); }
        catch (e) { rollbackFailed = true; }
      }
      throw new Error(error.message + (rollbackFailed
        ? '；部分设置回滚失败，请保留备份并重试恢复。' : '；已回滚本次写入。'));
    }
    location.reload();
  }

  function openSettingsBackup() {
    const { root, dialog, close, setStatus } = openToolDialog('设置备份与恢复', `
      <p>备份方向、字形、快捷键、全部站点偏好、自定义词典及浮动按钮设置。</p>
      <p class="hint">恢复会覆盖所有设置并刷新当前页面；其他已打开页面刷新后完整应用。仅接受本工具导出的 JSON，最大 16 MB。</p>
      <input type="file" accept=".json,application/json" hidden>
      <div class="actions">
        <button type="button" data-action="export">导出全部设置</button>
        <button type="button" data-action="import">选择备份</button>
        <button type="button" data-action="cancel">关闭</button>
        <button type="button" class="primary" data-action="save" disabled>恢复并刷新</button>
      </div>`);
    const fileInput = root.querySelector('input[type="file"]');
    const restore = root.querySelector('[data-action="save"]');
    let pending = null;
    let importRevision = 0;
    restore.disabled = true;
    root.querySelector('[data-action="cancel"]').addEventListener('click', close);
    root.querySelector('[data-action="import"]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const revision = ++importRevision;
      pending = null;
      restore.disabled = true;
      try {
        if (file.size > SETTINGS_BACKUP_LIMIT) throw new Error('文件不能超过 16 MB。');
        const next = validateSettingsBackup(JSON.parse(await file.text()));
        if (!dialog.isConnected || revision !== importRevision) return;
        pending = next;
        restore.disabled = false;
        const settings = next.settings;
        setStatus('备份校验通过：' + Object.keys(settings.sitePreferences).length + ' 个网站，' +
          (settings.dictionary.t2s.length + settings.dictionary.s2t.length) + ' 条词典规则。点击“恢复并刷新”后生效。');
      } catch (e) { if (dialog.isConnected && revision === importRevision) setStatus('导入失败：' + e.message, true); }
      finally { fileInput.value = ''; }
    });
    restore.addEventListener('click', () => {
      if (!pending || !window.confirm('确定覆盖全部设置并刷新当前页面？\n建议先导出当前设置备份。')) return;
      try { restoreSettingsBackup(pending); }
      catch (e) { setStatus('恢复失败：' + e.message, true); }
    });
    root.querySelector('[data-action="export"]').addEventListener('click', () => {
      try {
        const blob = new Blob([JSON.stringify(createSettingsBackup(), null, 2)], { type: 'application/json' });
        if (blob.size > SETTINGS_BACKUP_LIMIT) throw new Error('备份超过 16 MB，请先清理设置。');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'zh-t2s-settings.json';
        root.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setStatus('已导出全部已保存设置。');
      } catch (e) { setStatus('导出失败：' + e.message, true); }
    });
  }

  // 独立模态编辑器：不随 refreshMenu 重绘，草稿只在保存时写入 GM 存储。
  let dictionaryDialog = null;
  function openDictionaryEditor(scope = 'global') {
    const editingSite = scope === 'site';
    closeFloatPanel();
    if (dictionaryDialog) { dictionaryDialog.focus(); return; }
    syncDictionaryFromStorage(); // 不依赖 visibilitychange，重新打开即可读取其他页面的修改
    const dialog = document.createElement('dialog');
    dialog.className = 'ignore-opencc';
    dialog.setAttribute('aria-label', '自定义词典');
    Object.assign(dialog.style, {
      position: 'fixed', inset: '0', margin: 'auto',
      width: '560px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100dvh - 32px)',
      boxSizing: 'border-box', padding: '0', border: '1px solid #dce2eb', borderRadius: '14px',
      background: '#fff', color: '#1f2329', boxShadow: '0 16px 64px #0005', overflow: 'auto'
    });
    const host = document.createElement('div');
    dialog.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        *{box-sizing:border-box} [hidden]{display:none!important}
        .body{padding:20px;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;color:#1f2329;background:#fff}
        h2{font-size:18px;margin:0 0 8px} p{margin:8px 0;color:#596579;font-size:13px}
        .tabs,.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
        button{font:inherit;border:1px solid #d4dce8;border-radius:8px;padding:7px 12px;background:#f6f8fb;color:#263449;cursor:pointer}
        button[aria-pressed="true"],.save{background:#2f6bff;color:#fff;border-color:#2f6bff}
        button:focus-visible,textarea:focus-visible{outline:2px solid #2f6bff;outline-offset:2px}
        textarea{display:block;width:100%;height:220px;resize:vertical;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:14px/1.7 ui-monospace,monospace;background:#fff;color:#1f2329}
        .status{min-height:24px;color:#596579;white-space:pre-wrap;overflow-wrap:anywhere}
        .status[data-error="true"]{color:#b42318}
        .preview{margin:10px 0 2px}
        .preview input{display:block;width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#1f2329;background:#fff}
        .preview-out{margin-top:6px;padding:8px 10px;border:1px dashed #d4dce8;border-radius:8px;background:#f9fbff;min-height:20px;font-size:13px;color:#263449;word-break:break-word}
        .actions{justify-content:flex-end}.hint{font-size:12px}
      </style>
      <div class="body">
        <h2>自定义词典</h2>
        <p>每行填写：原词 =&gt; 替换为。分隔符也可用 -&gt;、→、＝＞；从表格复制的两列可直接粘贴，列间制表符会自动识别。手动按 Tab 键会跳到下一个控件。左右相同可保留原词，删除整行即可删除规则。</p>
        <p class="hint">${editingSite ? '仅此网站生效，同原词覆盖全局；清空后继承全局。' : '全站生效，站点同原词可覆盖。'}两个方向独立。同位置优先最长词，结果不再转换；不能跨网页文本节点匹配。每方向最多 1000 条。</p>
        <div class="tabs">
          <button type="button" data-direction="t2s" aria-pressed="true">繁→简</button>
          <button type="button" data-direction="s2t" aria-pressed="false">简→繁（台湾／香港共用）</button>
        </div>
        <textarea aria-label="繁转简词典" data-editor="t2s" spellcheck="false" placeholder="滑鼠 => 鼠标&#10;乾隆 => 乾隆"></textarea>
        <textarea aria-label="简转繁词典" data-editor="s2t" spellcheck="false" placeholder="头发 => 頭髮&#10;某人名 => 某人名" hidden></textarea>
        <p class="hint">首尾空格会去除；词内不能含 =&gt; 或制表符；每条规则占一行，不使用正则表达式。</p>
        <div class="preview">
          <input type="text" data-preview-input spellcheck="false" aria-label="转换预览输入" placeholder="试一下：输入示例文字，立即看到结果">
          <div class="preview-out" data-preview-out aria-live="polite">预览结果会显示在这里</div>
        </div>
        <div class="status" role="status" aria-live="polite"></div>
        <input type="file" accept=".json,application/json" hidden>
        <div class="actions">
          <button type="button" data-action="import">导入 JSON</button>
          <button type="button" data-action="export">导出 JSON</button>
          <button type="button" data-action="cancel">取消</button>
          <button type="button" class="save" data-action="save">保存并应用</button>
        </div>
      </div>`;
    const editors = {
      t2s: root.querySelector('[data-editor="t2s"]'),
      s2t: root.querySelector('[data-editor="s2t"]')
    };
    const status = root.querySelector('.status');
    function showStatus(message, error = false) {
      status.textContent = message;
      status.dataset.error = String(error);
    }
    function fillEditors(data) {
      for (const direction of ['t2s', 's2t']) {
        editors[direction].value = data[direction].map(([a, b]) => a + ' => ' + b).join('\n');
      }
    }
    function readEditors() {
      const data = { t2s: [], s2t: [] };
      for (const direction of ['t2s', 's2t']) {
        const label = direction === 't2s' ? '繁→简' : '简→繁';
        const lines = editors[direction].value.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (!line.trim()) return;
          const parts = splitDictionaryLine(line);
          if (!parts) {
            throw new Error(label + '第 ' + (index + 1) + ' 行缺少分隔符，可用 =>、->、→、＝＞，或从表格粘贴。');
          }
          data[direction].push([parts[0].trim(), parts[1].trim()]);
        });
      }
      return validateDictionary(data);
    }
    fillEditors(editingSite ? siteDictionary : dictionary);
    const initialDraft = JSON.stringify(editingSite ? siteDictionary : dictionary);
    function hasChanges() {
      try { return JSON.stringify(readEditors()) !== initialDraft; }
      catch (e) { return true; }
    }
    function cancel() {
      if (!hasChanges() || window.confirm('放弃尚未保存的词典修改？')) dialog.close();
    }
    const previewInput = root.querySelector('[data-preview-input]');
    const previewOut = root.querySelector('[data-preview-out]');
    let previewCache = { key: '', tries: null };
    let previewTimer = 0;
    let isComposing = false;
    function activeDirection() {
      const active = root.querySelector('[data-direction][aria-pressed="true"]');
      return active ? active.dataset.direction : 't2s';
    }
    /** 用当前草稿预览示例文字：不写入存储，也不影响页面转换 */
    function refreshPreview() {
      if (isComposing) return;
      const sample = previewInput.value;
      if (!sample) { previewOut.textContent = '预览结果会显示在这里'; return; }
      if (!hasOpenCC) { previewOut.textContent = '转换引擎未加载，无法预览。'; return; }
      let draft;
      try { draft = readEditors(); }
      catch (e) { previewOut.textContent = '规则有误，无法预览。'; showStatus(e.message, true); return; }
      const key = JSON.stringify(draft);
      if (!previewCache.tries || previewCache.key !== key) {
        previewCache = { key, tries: buildDictionaryTries(editingSite ? mergeDictionaries(dictionary, draft) : mergeDictionaries(draft, siteDictionary)).tries };
      }
      const direction = activeDirection();
      const convertFn = direction === 's2t' ? converterForState('s2t') : converters.t2s;
      if (!convertFn) { previewOut.textContent = '转换引擎未加载，无法预览。'; return; }
      try {
        previewOut.textContent = applyDictionary(sample, convertFn, previewCache.tries[direction]);
      } catch (e) { previewOut.textContent = '预览失败：' + e.message; }
    }
    /** 独立于预览的输入反馈：解析成功显示条数，失败显示首条错误 */
    function refreshValidationFeedback() {
      if (isComposing) return;
      let draft;
      try { draft = readEditors(); }
      catch (e) { showStatus(e.message, true); return; }
      const total = draft.t2s.length + draft.s2t.length;
      if (!total) { showStatus('还没有规则。每行一条：原词 => 替换。'); return; }
      showStatus('已识别 ' + total + ' 条规则（繁→简 ' + draft.t2s.length + ' 条，简→繁 ' + draft.s2t.length + ' 条）。');
    }
    refreshValidationFeedback();
    /** 去抖刷新：合成期间（拼音等）不触发，避免半成品文本闪错误 */
    function scheduleFeedbackRefresh() {
      clearTimeout(previewTimer);
      if (isComposing) return;
      previewTimer = setTimeout(() => {
        if (isComposing) return;
        refreshValidationFeedback();
        refreshPreview();
      }, 300);
    }
    previewInput.addEventListener('input', (e) => { if (!e.isComposing) refreshPreview(); });
    for (const direction of ['t2s', 's2t']) {
      editors[direction].addEventListener('input', (e) => { if (!e.isComposing) scheduleFeedbackRefresh(); });
    }
    for (const input of [editors.t2s, editors.s2t, previewInput]) {
      input.addEventListener('compositionstart', () => {
        isComposing = true;
        clearTimeout(previewTimer);
      });
      input.addEventListener('compositionend', () => {
        isComposing = false;
        if (input === previewInput) refreshPreview();
        scheduleFeedbackRefresh();
      });
    }
    root.querySelectorAll('[data-direction]').forEach((button) => {
      button.addEventListener('click', () => {
        root.querySelectorAll('[data-direction]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
        for (const direction of ['t2s', 's2t']) editors[direction].hidden = direction !== button.dataset.direction;
        editors[button.dataset.direction].focus();
        refreshPreview();
      });
    });
    root.querySelector('[data-action="cancel"]').addEventListener('click', cancel);
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); cancel(); });
    dialog.addEventListener('close', () => { clearTimeout(previewTimer); dictionaryDialog = null; dialog.remove(); });
    root.querySelector('[data-action="save"]').addEventListener('click', () => {
      clearTimeout(previewTimer);
      try {
        // 打开编辑器后若存储已被其他页面改写，先确认再覆盖，避免静默丢失对方改动
        const stored = editingSite ? readSiteDictionary() : readStoredDictionary();
        if (stored && JSON.stringify(stored) !== initialDraft &&
            !window.confirm('词典已在其他页面更新，继续保存会覆盖对方的修改。\n建议先取消并重新打开编辑器查看最新内容。确定覆盖吗？')) return;
        if (editingSite) saveSiteDictionary(readEditors());
        else saveDictionary(readEditors());
        dialog.close();
      } catch (e) { showStatus('保存失败：' + e.message, true); }
    });
    const fileInput = root.querySelector('input[type="file"]');
    root.querySelector('[data-action="import"]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      clearTimeout(previewTimer);
      try {
        const file = fileInput.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) throw new Error('文件不能超过 2 MB。');
        const data = validateDictionary(JSON.parse(await file.text()));
        if (!dialog.isConnected) return;
        if (hasChanges() && !window.confirm('导入将替换两个方向的当前草稿，是否继续？')) return;
        fillEditors(data);
        refreshPreview();
        showStatus('已导入两个方向的草稿，点击“保存并应用”后生效。');
      } catch (e) { showStatus('导入失败：' + e.message, true); }
      finally { fileInput.value = ''; }
    });
    root.querySelector('[data-action="export"]').addEventListener('click', () => {
      clearTimeout(previewTimer);
      try {
        const data = readEditors();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'zh-t2s-dictionary.json';
        root.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        showStatus('已导出当前草稿；尚未保存的修改需点击“保存并应用”。');
      } catch (e) { showStatus('导出失败：' + e.message, true); }
    });
    document.documentElement.appendChild(dialog);
    dictionaryDialog = dialog;
    dialog.showModal();
  }

  function preferenceSelect(label, choices, value, onChange, control) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', label);
    select.setAttribute('data-control', control);
    for (const [key, text] of choices) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = text;
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function renderSitePreferenceControl(panel) {
    const label = document.createElement('label');
    label.className = 'zh-t2s-field';
    const title = document.createElement('span');
    title.className = 'zh-t2s-field-title';
    title.textContent = '此网站';
    const host = document.createElement('span');
    host.className = 'zh-t2s-host';
    host.textContent = currentHost;
    title.appendChild(host);
    label.appendChild(title);
    label.appendChild(preferenceSelect('此网站的转换偏好', [
      ['follow', '跟随全局'], ['t2s', '繁→简'], ['s2t', '简→繁'], ['off', '不转换']
    ], sitePreference, setSitePreference, 'site'));
    panel.appendChild(label);
    const hint = document.createElement('div');
    hint.className = 'zh-t2s-hint' + (sitePreferenceError ? ' error' : '');
    hint.textContent = sitePreferenceError || (sitePreference === 'follow'
      ? '当前随全局：' + ({ t2s: '繁→简', s2t: '简→繁', off: '不转换' })[state]
      : '已保存，仅对此网站生效。');
    hint.setAttribute('role', 'status');
    panel.appendChild(hint);
  }

  function renderGlobalPreferenceControl(panel) {
    const label = document.createElement('label');
    label.className = 'zh-t2s-field';
    const title = document.createElement('span');
    title.className = 'zh-t2s-field-title';
    title.textContent = '全局默认';
    label.appendChild(title);
    label.appendChild(preferenceSelect('全局默认转换方式', [
      ['t2s', '繁→简'], ['s2t', '简→繁'], ['off', '不转换']
    ], state, setState, 'global'));
    panel.appendChild(label);
    const hint = document.createElement('div');
    hint.className = 'zh-t2s-hint';
    hint.textContent = '仅影响选择“跟随全局”的网站。';
    panel.appendChild(hint);
  }

  // 保持扁平布局：当前网站优先，全局默认次之，低频操作收在底部。
  function renderFloatPanelContent() {
    if (!floatPanel) return;
    const focused = floatPanel.contains(document.activeElement)
      ? document.activeElement?.getAttribute?.('data-control') : null;
    const scrollTop = floatPanel.scrollTop;
    floatPanel.innerHTML = '';
    floatPanel.appendChild(floatPanelHeader());
    const site = document.createElement('div');
    site.className = 'zh-t2s-site-card';
    renderSitePreferenceControl(site);
    site.appendChild(floatPanelRow(pagePaused ? '恢复本页转换' : '本页临时暂停 · 查看原文', () => setPagePaused(!pagePaused), { control: 'pause' }));
    floatPanel.appendChild(site);
    if (effectiveState() === 's2t') {
      const style = document.createElement('div');
      style.className = 'zh-t2s-style';
      const title = document.createElement('div');
      title.className = 'zh-t2s-field-title';
      title.textContent = '繁体字形（所有网站共用）';
      const segments = document.createElement('div');
      segments.className = 'zh-t2s-segments';
      segments.setAttribute('role', 'group');
      segments.setAttribute('aria-label', '繁体字形');
      for (const [value, text] of [['tw', '台湾'], ['hk', '香港']]) {
        const button = floatPanelSeg(text, traditionalStyle === value);
        button.setAttribute('data-control', 'style-' + value);
        button.addEventListener('click', (e) => { e.stopPropagation(); setTraditionalStyle(value); });
        segments.appendChild(button);
      }
      style.appendChild(title);
      style.appendChild(segments);
      site.appendChild(style);
    }
    floatPanel.appendChild(floatPanelDivider());
    renderGlobalPreferenceControl(floatPanel);
    floatPanel.appendChild(floatPanelDivider());
    floatPanel.appendChild(floatPanelRow('自定义词典 · ' + (dictionary.t2s.length + dictionary.s2t.length) + ' 条规则', openDictionaryEditor, { control: 'dictionary' }));
    floatPanel.appendChild(floatPanelRow('此网站忽略区域', openIgnoreRules, { control: 'ignore' }));
    floatPanel.appendChild(floatPanelRow('此网站词典 · ' + (siteDictionary.t2s.length + siteDictionary.s2t.length) + ' 条', () => openDictionaryEditor('site'), { control: 'site-dictionary' }));
    floatPanel.appendChild(floatPanelRow('选中文字转换', openSelectionTool, { control: 'selection' }));
    const footer = document.createElement('div');
    footer.className = 'zh-t2s-footer';
    footer.appendChild(floatPanelRow('站点偏好管理', openSiteManager, { control: 'sites' }));
    footer.appendChild(floatPanelRow('设置备份与恢复', openSettingsBackup, { control: 'backup' }));
    footer.appendChild(floatPanelRow('隐藏浮动按钮', () => setFloatBtnEnabled(false), { control: 'hide' }));
    footer.appendChild(floatPanelRow('重置所有设置', resetAllSettings, { danger: true, control: 'reset' }));
    floatPanel.appendChild(footer);
    floatPanel.scrollTop = scrollTop;
    if (focused) floatPanel.querySelector?.('[data-control="' + focused + '"]')?.focus({ preventScroll: true });
    positionFloatPanel();
  }

  function positionFloatPanel() {
    if (!floatPanel || !floatBtn) return;
    const margin = 8;
    const gap = 8;
    const rect = floatBtn.getBoundingClientRect();
    const width = window.innerWidth;
    const height = window.innerHeight;
    const above = Math.max(0, rect.top - gap - margin);
    const below = Math.max(0, height - rect.bottom - gap - margin);
    // 内容高度变化或窗口缩小时，重新选择可用空间更大的一侧并限制滚动高度。
    const useAbove = above >= below;
    const available = Math.max(above, below);
    floatPanel.style.maxHeight = Math.max(0, Math.min(available, height - margin * 2)) + 'px';
    floatPanel.style.right = 'auto';
    floatPanel.style.bottom = 'auto';
    const panelRect = floatPanel.getBoundingClientRect();
    floatPanel.style.left = Math.max(margin, Math.min(rect.right - panelRect.width, width - panelRect.width - margin)) + 'px';
    const targetTop = useAbove ? rect.top - gap - panelRect.height : rect.bottom + gap;
    floatPanel.style.top = Math.max(margin, Math.min(targetTop, height - panelRect.height - margin)) + 'px';
  }

  function openFloatPanel() {
    if (floatPanelOpen) return;
    selectionSnapshot = window.getSelection?.()?.toString() || '';
    syncSitePreferenceFromStorage();
    floatPanelOpen = true;
    floatPanel = document.createElement('div');
    floatPanel.id = 'zh-t2s-floatpanel';
    floatPanel.className = 'ignore-opencc zh-t2s-floatpanel';
    floatPanel.setAttribute('role', 'region');
    floatPanel.setAttribute('aria-label', '繁简转换设置');
    document.documentElement.appendChild(floatPanel);
    renderFloatPanelContent();
    floatBtn.setAttribute('aria-expanded', 'true');
    window.addEventListener('resize', positionFloatPanel);
    document.addEventListener('keydown', onFloatPanelKeydown, true);
    // 延后监听，避免打开面板的这次点击将其立即关闭。
    setTimeout(() => {
      if (floatPanelOpen) document.addEventListener('click', onDocClickCloseFloat, true);
    }, 0);
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
   * 清除全部持久化偏好（词典、方向、繁体字形、快捷键、站点偏好、浮动按钮），恢复默认后刷新页面。
   * 重置后刷新页面；站点偏好变更则就地生效。
   * ============================================================ */
  function resetAllSettings() {
    if (!window.confirm('确定重置所有设置？\n将清除自定义词典、方向、繁体字形、快捷键、站点偏好与浮动按钮偏好，并恢复默认。')) return;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(STATE_KEY, 't2s');
        GM_setValue(DICTIONARY_KEY, { t2s: [], s2t: [] });
        GM_setValue(SITE_DICTIONARY_KEY, {});
        GM_setValue(IGNORE_RULES_KEY, {});
        GM_setValue(TRAD_STYLE_KEY, 'tw');
        GM_setValue(SHORTCUT_KEY_T2S, { key: 'F8', ctrl: false, alt: false, shift: false, meta: false });
        GM_setValue(SHORTCUT_KEY_S2T, { key: 'F9', ctrl: false, alt: false, shift: false, meta: false });
        GM_setValue(WHITELIST_KEY, []);
        GM_setValue(SITE_PREFERENCES_KEY, {});
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
    if (effectiveState() !== 'off') {
      convert = converterForState(effectiveState());
      // 先开启观察，避免初始扫描期间外部脚本插入的内容被遗漏
      observer.observe(document.documentElement, observerOptions());
      // 初始全量扫描（TreeWalker 仅收集引用，转换在空闲帧中分批进行）
      enqueueSubtree(document.documentElement);
      scheduleIdle();
    }
    registerMenu(); // 无论站点停用/关闭/无 opencc 状态都注册菜单，供用户管理
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start(); // @run-at document-idle 下通常直接走到这里
  }
})();
