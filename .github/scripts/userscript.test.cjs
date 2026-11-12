'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadUserscript } = require('./userscript-harness.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const data = (t2s = [], s2t = []) => ({ t2s, s2t });
const editorSelector = direction => '[data-editor="' + direction + '"]';
const actionSelector = action => '[data-action="' + action + '"]';

test('full settings export reads current storage and merges legacy exclusions with explicit site choices', async () => {
  const harness = loadUserscript({ whitelist: ['legacy.test', 'example.test'] });
  harness.storage.set('zh-t2s-site-preferences', { 'example.test': 'follow', 'new.test': 's2t' });
  harness.storage.set('zh-t2s-enabled', 'off');
  harness.storage.set('zh-t2s-lastdir', 's2t');
  harness.storage.set('zh-t2s-traditional-style', 'hk');
  harness.storage.set('zh-t2s-shortcut-t2s', { key: 'T', ctrl: true, alt: true, shift: false, meta: false });
  harness.storage.set('zh-t2s-dictionary', data([['新词', '结果']]));
  harness.storage.set('zh-t2s-floatpos', { left: '12.5px', top: '30px' });
  const backup = harness.openBackup();
  await backup.get(actionSelector('export')).click();
  const exported = JSON.parse(await harness.downloads[0].text());
  assert.equal(exported.format, 'zh-t2s-settings');
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.settings.state, 'off');
  assert.equal(exported.settings.lastDirection, 's2t');
  assert.equal(exported.settings.traditionalStyle, 'hk');
  assert.equal(exported.settings.shortcuts.t2s.key, 'T');
  assert.equal(exported.settings.shortcuts.t2s.ctrl, true);
  assert.deepEqual(exported.settings.sitePreferences, { 'legacy.test': 'off', 'example.test': 'follow', 'new.test': 's2t' });
  assert.deepEqual(exported.settings.dictionary, data([['新词', '结果']]));
  assert.deepEqual(exported.settings.floatButton, { enabled: false, position: { left: '12.5px', top: '30px' } });
  assert.equal(harness.scans, 0);
  assert.equal(harness.writes.length, 0);
});

test('full settings restore validates first and writes without scans or broadcasts, then reloads once', () => {
  const source = loadUserscript({ state: 'off', sitePreferences: { 'example.test': 's2t' },
    dictionary: data([['原词', '自定义结果']]), whitelist: ['legacy.test'] });
  source.storage.set('zh-t2s-lastdir', 's2t');
  source.storage.set('zh-t2s-traditional-style', 'hk');
  source.storage.set('zh-t2s-floatpos', { left: '100px', top: '200px' });
  const original = plain(source.api.createSettingsBackup());
  const destination = loadUserscript({ whitelist: ['discard.test'] });
  destination.api.restoreSettingsBackup(original);
  assert.deepEqual(plain(destination.api.createSettingsBackup()), original);
  assert.deepEqual(destination.storage.get('zh-t2s-whitelist'), []);
  assert.equal(destination.reloads, 1);
  assert.equal(destination.scans, 0);
  assert.equal(destination.broadcasts.length, 0);
  assert.equal(destination.api.effectiveState(), 't2s'); // 在刷新前不安装部分配置。
});

test('full settings validation rejects invalid fields and never writes them', () => {
  const harness = loadUserscript();
  const base = plain(harness.api.createSettingsBackup());
  const changes = [
    backup => { backup.schemaVersion = 2; },
    backup => { backup.settings.state = 'anything'; },
    backup => { backup.settings.lastDirection = 'off'; },
    backup => { backup.settings.traditionalStyle = 't'; },
    backup => { backup.settings.shortcuts.s2t.ctrl = 'true'; },
    backup => { backup.settings.sitePreferences = { 'bad.test/path': 'off' }; },
    backup => { backup.settings.dictionary = data([['重复', '1'], ['重复', '2']]); },
    backup => { backup.settings.floatButton.enabled = 'false'; },
    backup => { backup.settings.floatButton.position = { left: 'url(bad)', top: '4px' }; }
  ];
  for (const change of changes) {
    const invalid = structuredClone(base);
    change(invalid);
    assert.throws(() => harness.api.restoreSettingsBackup(invalid));
  }
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.reloads, 0);
  const withExtraKeys = structuredClone(base);
  withExtraKeys.settings['arbitrary-storage-key'] = true;
  assert.equal('arbitrary-storage-key' in harness.api.validateSettingsBackup(withExtraKeys).settings, false);
});

test('partial restore failure rolls back all attempted keys and leaves the running converter unchanged', () => {
  const harness = loadUserscript({ dictionary: data([['原词', '旧结果']]) });
  const before = plain(harness.api.createSettingsBackup());
  const next = structuredClone(before);
  next.settings.state = 's2t';
  next.settings.lastDirection = 's2t';
  next.settings.traditionalStyle = 'hk';
  let fail = true;
  harness.failWrites(key => {
    if (key === 'zh-t2s-dictionary' && fail) { fail = false; return new Error('模拟中途写入失败'); }
    return null;
  });
  assert.throws(() => harness.api.restoreSettingsBackup(next), /模拟中途写入失败.*已回滚/);
  assert.deepEqual(plain(harness.api.createSettingsBackup()), before);
  assert.equal(harness.reloads, 0);
  assert.equal(harness.scans, 0);
  assert.equal(harness.api.safeConvert('原词'), '旧结果');
});

test('backup UI requires valid import and confirmation; failed rollback never reports success', async () => {
  const harness = loadUserscript();
  const backup = harness.openBackup();
  const fileInput = backup.get('input[type="file"]');
  const serialized = JSON.stringify(harness.api.createSettingsBackup());
  fileInput.files = [{ size: Buffer.byteLength(serialized), text: async () => serialized }];
  await fileInput.fire('change');
  assert.equal(backup.get(actionSelector('save')).disabled, false);
  assert.equal(harness.writes.length, 0);
  harness.setConfirmation(false);
  await backup.get(actionSelector('save')).click();
  assert.equal(harness.writes.length, 0);
  harness.setConfirmation(true);
  harness.failWrites(new Error('存储不可用'));
  await backup.get(actionSelector('save')).click();
  assert.match(backup.get('.status').textContent, /恢复失败.*回滚失败/);
  assert.equal(backup.get('.status').dataset.error, 'true');
  assert.equal(harness.reloads, 0);
  harness.failWrites(null);
  await backup.get(actionSelector('save')).click();
  assert.equal(harness.reloads, 1);
});

test('oversized, invalid and stale backup imports cannot enable an earlier pending restore', async () => {
  const harness = loadUserscript();
  const backup = harness.openBackup();
  const fileInput = backup.get('input[type="file"]');
  const serialized = JSON.stringify(harness.api.createSettingsBackup());
  let resolveRead;
  fileInput.files = [{ size: 1, text: () => new Promise(resolve => { resolveRead = resolve; }) }];
  const slowImport = fileInput.fire('change');
  fileInput.files = [{ size: 16 * 1024 * 1024 + 1, text: () => assert.fail('超限文件不应读取') }];
  await fileInput.fire('change');
  assert.match(backup.get('.status').textContent, /16 MB/);
  resolveRead(serialized);
  await slowImport;
  assert.equal(backup.get(actionSelector('save')).disabled, true);
  fileInput.files = [{ size: 2, text: async () => '{}' }];
  await fileInput.fire('change');
  assert.match(backup.get('.status').textContent, /导入失败/);
  await backup.get(actionSelector('save')).click();
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.reloads, 0);
});

test('backup export read failure reports an error and creates no download', async () => {
  const harness = loadUserscript();
  const backup = harness.openBackup();
  harness.failReads(new Error('模拟读取失败'));
  await backup.get(actionSelector('export')).click();
  assert.match(backup.get('.status').textContent, /导出失败.*模拟读取失败/);
  assert.equal(backup.get('.status').dataset.error, 'true');
  assert.equal(harness.downloads.length, 0);
});

test('site preferences override global defaults, match exact hosts and survive reload', () => {
  for (const mode of ['follow', 't2s', 's2t', 'off']) {
    const harness = loadUserscript({ state: 'off', sitePreferences: { 'example.test': mode } });
    assert.equal(harness.api.effectiveState(), mode === 'follow' ? 'off' : mode);
    harness.api.setState('t2s');
    assert.equal(harness.api.effectiveState(), mode === 'follow' ? 't2s' : mode);
    assert.equal(harness.api.setSitePreference('s2t'), true);
    assert.equal(harness.storage.get('zh-t2s-enabled'), 't2s');
    const saved = harness.storage.get('zh-t2s-site-preferences');
    assert.equal(loadUserscript({ sitePreferences: saved }).api.effectiveState(), 's2t');
    assert.equal(loadUserscript({ hostname: 'sub.example.test', sitePreferences: saved }).api.effectiveState(), 't2s');
  }
});

test('bootstrap uses the site direction even when the global default is off', () => {
  const { api, document, observations } = loadUserscript({ state: 'off',
    sitePreferences: { 'example.test': 's2t' }, dictionary: data([['ASCII', '错误方向']], [['ASCII', '正確方向']]) });
  const text = document.createTextNode('ASCII');
  document.documentElement.appendChild(text);
  api.start();
  api.processQueue({ timeRemaining: () => 10 });
  assert.equal(text.nodeValue, '正確方向');
  assert.equal(observations.length, 1);
});

test('site changes use the correct dictionary and restore original text and attributes', () => {
  const { api, document } = loadUserscript({ dictionary: data([['原文', '全局结果']], [['原文', '站點結果']]) });
  const el = document.createElement('div');
  const text = document.createTextNode('原文');
  el.appendChild(text);
  el.setAttribute('title', '原文');
  document.documentElement.appendChild(el);
  for (const [mode, expected] of [['s2t', '站點結果'], ['t2s', '全局结果'], ['off', '原文'], ['follow', '全局结果']]) {
    api.setSitePreference(mode);
    api.processQueue({ timeRemaining: () => 10 });
    assert.equal(text.nodeValue, expected, mode);
    assert.equal(el.getAttribute('title'), expected, mode);
  }
  api.setSitePreference('s2t');
  api.saveDictionary(data([['原文', '全局结果']], [['原文', '新站點結果']]));
  api.processQueue({ timeRemaining: () => 10 });
  assert.equal(text.nodeValue, '新站點結果');
  const before = api.effectiveState();
  api.setTraditionalStyle('hk');
  api.processQueue({ timeRemaining: () => 10 });
  assert.equal(api.effectiveState(), before);
  assert.equal(text.nodeValue, '新站點結果');
});

test('site preference save preserves other sites and explicitly overrides legacy exclusions', () => {
  const harness = loadUserscript({ whitelist: ['example.test', 'legacy.test'] });
  harness.storage.set('zh-t2s-site-preferences', { 'other.test': 's2t' });
  harness.api.setSitePreference('follow');
  assert.deepEqual(plain(harness.storage.get('zh-t2s-site-preferences')), {
    'example.test': 'follow', 'legacy.test': 'off', 'other.test': 's2t'
  });
  const reloaded = loadUserscript({ whitelist: ['example.test'],
    sitePreferences: harness.storage.get('zh-t2s-site-preferences') });
  assert.equal(reloaded.api.effectiveState(), 't2s');
  assert.equal(harness.api.setSitePreference('invalid'), false);
});

test('failed site preference save leaves settings and DOM unchanged and allows retry', () => {
  const harness = loadUserscript();
  const before = harness.scans;
  harness.failWrites(new Error('模拟存储失败'));
  assert.equal(harness.api.setSitePreference('s2t'), false);
  assert.equal(harness.api.preference(), 'follow');
  assert.equal(harness.api.effectiveState(), 't2s');
  assert.deepEqual(harness.storage.get('zh-t2s-site-preferences'), {});
  assert.equal(harness.scans, before);
  assert.equal(harness.observations.length, 0);
  const panel = harness.document.createElement('div');
  harness.api.renderSitePreferenceControl(panel);
  assert.match(panel.children[1].textContent, /保存失败/);
  harness.failWrites(null);
  assert.equal(harness.api.setSitePreference('s2t'), true);
  assert.equal(harness.api.effectiveState(), 's2t');
});

test('site preference broadcasts and visibility updates restore and reconvert without rebroadcast', async () => {
  const harness = loadUserscript();
  harness.api.setSitePreference('s2t');
  assert.equal(harness.broadcasts.at(-1).type, 'zh-t2s-site-preference');
  const count = harness.broadcasts.length;
  harness.storage.set('zh-t2s-site-preferences', { 'example.test': 'off' });
  harness.receiveBroadcast({ type: 'zh-t2s-site-preference' });
  assert.equal(harness.api.effectiveState(), 'off');
  harness.storage.set('zh-t2s-site-preferences', { 'example.test': 't2s' });
  harness.document.visibilityState = 'visible';
  await harness.document.fire('visibilitychange');
  assert.equal(harness.api.effectiveState(), 't2s');
  assert.equal(harness.broadcasts.length, count);
  harness.receiveBroadcast({ type: 'zh-t2s-state', state: 's2t' });
  assert.equal(harness.api.effectiveState(), 't2s');
});

test('site preference selector exposes four choices and saves immediately', async () => {
  const { api, document, storage } = loadUserscript();
  const panel = document.createElement('div');
  api.renderSitePreferenceControl(panel);
  const select = panel.children[0].children.find(child => child.nodeName === 'SELECT');
  assert.deepEqual(select.children.map(option => option.value), ['follow', 't2s', 's2t', 'off']);
  assert.equal(select.value, 'follow');
  select.value = 'off';
  await select.fire('change');
  assert.equal(api.effectiveState(), 'off');
  assert.equal(storage.get('zh-t2s-site-preferences')['example.test'], 'off');
});

test('global selector changes only the global default and explains its scope', async () => {
  const { api, document, storage } = loadUserscript({ sitePreferences: { 'example.test': 's2t' } });
  const panel = document.createElement('div');
  api.renderGlobalPreferenceControl(panel);
  const select = panel.children[0].children.find(child => child.nodeName === 'SELECT');
  assert.equal(select.value, 't2s');
  select.value = 'off';
  await select.fire('change');
  assert.equal(storage.get('zh-t2s-enabled'), 'off');
  assert.equal(api.effectiveState(), 's2t');
  assert.match(panel.children[1].textContent, /仅影响.*跟随全局/);
  const sitePanel = document.createElement('div');
  api.renderSitePreferenceControl(sitePanel);
  assert.match(sitePanel.children[1].textContent, /仅对此网站生效/);
  api.setSitePreference('follow');
  const following = document.createElement('div');
  api.renderSitePreferenceControl(following);
  assert.match(following.children[1].textContent, /当前随全局：不转换/);
});

test('page shortcuts modify the selected scope while global menus retain global defaults', () => {
  const { api, storage } = loadUserscript();
  api.setPageState('s2t');
  assert.equal(storage.get('zh-t2s-enabled'), 's2t');
  api.setSitePreference('t2s');
  api.setPageState('off');
  assert.equal(storage.get('zh-t2s-enabled'), 's2t');
  assert.equal(storage.get('zh-t2s-site-preferences')['example.test'], 'off');
  api.setState('off');
  assert.equal(api.effectiveState(), 'off');
  api.setSitePreference('s2t');
  assert.equal(api.effectiveState(), 's2t');
});

test('missing OpenCC keeps conversion disabled while site preferences remain configurable', () => {
  const harness = loadUserscript({ hasOpenCC: false });
  harness.api.start();
  harness.api.setSitePreference('s2t');
  assert.equal(harness.api.preference(), 's2t');
  assert.equal(harness.api.effectiveState(), 'off');
  assert.equal(harness.observations.length, 0);
  assert.equal(harness.scans, 0);
});

test('reset clears both site preferences and legacy exclusions', () => {
  const harness = loadUserscript({ whitelist: ['legacy.test'],
    sitePreferences: { 'example.test': 's2t', 'other.test': 'off' } });
  harness.api.resetAllSettings();
  assert.deepEqual(harness.storage.get('zh-t2s-site-preferences'), {});
  assert.deepEqual(harness.storage.get('zh-t2s-whitelist'), []);
  assert.equal(harness.reloads, 1);
});

test('state changes keep whitelisted pages inactive until removed from whitelist', () => {
  const harness = loadUserscript({ whitelist: ['example.test'] });
  for (const direction of ['s2t', 't2s', 'off', 't2s']) {
    harness.api.setState(direction);
    assert.equal(harness.api.effectiveState(), 'off');
    assert.equal(harness.scans, 0);
    assert.equal(harness.observations.length, 0);
  }
  assert.equal(harness.storage.get('zh-t2s-enabled'), 't2s');
  harness.api.setSitePreference('follow');
  assert.equal(harness.api.effectiveState(), 't2s');
  assert.ok(harness.scans > 0);
  assert.equal(harness.observations.length, 1);
});

test('ignore rules follow class changes and moves into and out of ignored ancestors', () => {
  const { api, document } = loadUserscript();
  const parent = document.createElement('div');
  const text = { parentElement: parent };
  assert.equal(api.shouldSkipText(text), false);
  parent.className = 'ignore-opencc';
  assert.equal(api.shouldSkipText(text), true);
  parent.className = '';
  assert.equal(api.shouldSkipText(text), false);
  const ignored = document.createElement('section');
  ignored.className = 'ignore-opencc';
  ignored.appendChild(parent);
  assert.equal(api.shouldSkipText(text), true);
  document.documentElement.appendChild(parent);
  assert.equal(api.shouldSkipText(text), false);
});

test('idle queue rechecks editor focus and ignore rules before writing text', () => {
  for (const change of ['focus', 'ignore', 'move']) {
    const { api, document } = loadUserscript({ dictionary: data([['繁體', '简体']]) });
    const parent = document.createElement('div');
    const text = { nodeType: 3, nodeValue: '繁體', parentElement: parent, isConnected: true };
    assert.equal(api.shouldSkipText(text), false);
    api.enqueueSubtree(text);
    if (change === 'focus') {
      parent.isContentEditable = true;
      document.activeElement = parent;
    } else if (change === 'ignore') {
      parent.className = 'ignore-opencc';
    } else {
      const ignored = document.createElement('section');
      ignored.className = 'ignore-opencc';
      ignored.appendChild(parent);
    }
    api.processQueue({ timeRemaining: () => 10 });
    assert.equal(text.nodeValue, '繁體', change);
    parent.isContentEditable = false;
    document.activeElement = null;
    parent.className = '';
    document.documentElement.appendChild(parent);
    api.enqueueSubtree(text);
    api.processQueue({ timeRemaining: () => 10 });
    assert.equal(text.nodeValue, '简体', change + ': converts when eligible again');
  }
});

test('full scans preserve nested text and attributes inside excluded tags', () => {
  for (const tag of ['object', 'noscript', 'textarea']) {
    const { api, document } = loadUserscript({ dictionary: data([['繁體', '简体']]) });
    const excluded = document.createElement(tag);
    const nested = document.createElement('span');
    const text = document.createTextNode('繁體');
    nested.setAttribute('title', '繁體');
    nested.appendChild(text);
    excluded.appendChild(nested);
    document.documentElement.appendChild(excluded);
    api.enqueueSubtree(document.documentElement);
    api.processQueue({ timeRemaining: () => 10 });
    assert.equal(text.nodeValue, '繁體', tag);
    assert.equal(nested.getAttribute('title'), '繁體', tag);
    document.documentElement.appendChild(nested);
    api.enqueueSubtree(document.documentElement);
    api.processQueue({ timeRemaining: () => 10 });
    assert.equal(text.nodeValue, '简体', tag);
    assert.equal(nested.getAttribute('title'), '简体', tag);
    excluded.appendChild(nested);
    api.setState('off');
    assert.equal(text.nodeValue, '繁體', tag + ': restore after move');
    assert.equal(nested.getAttribute('title'), '繁體', tag + ': restore attribute after move');
  }
});

test('all separators, whitespace and missing separators', () => {
  const { api } = loadUserscript();
  for (const separator of ['=>', '->', '→', '＝＞', '＝>', '\t']) {
    assert.deepEqual(plain(api.splitDictionaryLine(' 原词 ' + separator + ' 结果 '))
      .map(value => value.trim()), ['原词', '结果']);
  }
  assert.equal(api.splitDictionaryLine('没有分隔符'), null);
});

test('JSON import → editor → export/save preserves arrow sources in both directions', async () => {
  const harness = loadUserscript();
  const editor = harness.openEditor();
  const expected = data(
    ['->', '→', '＝＞', '＝>'].map(marker => ['A' + marker + 'B', '结果' + marker + '保留']),
    [['反→向', '結果']]
  );
  const json = JSON.stringify(expected);
  editor.get('input[type="file"]').files = [{ size: Buffer.byteLength(json), text: async () => json }];
  await editor.get('input[type="file"]').fire('change');
  assert.match(editor.get('.status').textContent, /已导入/);
  await editor.get(actionSelector('export')).click();
  assert.deepEqual(JSON.parse(await harness.downloads[0].text()), expected);
  await editor.get(actionSelector('save')).click();
  assert.deepEqual(harness.storage.get('zh-t2s-dictionary'), expected);
  assert.equal(editor.dialog.open, false);
});

test('invalid dictionaries are rejected, while trimming and Unicode are supported', () => {
  const { api } = loadUserscript();
  assert.deepEqual(plain(api.validateDictionary(data([[' 𠀀 ', ' 保留 ']]))), data([['𠀀', '保留']]));
  for (const invalid of [
    {}, data([['', '目标']]), data([['源', '']]), data([['源', 1]]),
    data([['重复', '甲'], ['重复', '乙']]), data([['源\n词', '目标']]),
    data([['源', '目\t标']]), data([['源=>词', '目标']]), data([['源', '目=>标']]),
    data([['长'.repeat(257), '目标']]), data([['源', '长'.repeat(1025)]]),
    data(Array.from({ length: 1001 }, (_, i) => ['源' + i, '目标']))
  ]) assert.throws(() => api.validateDictionary(invalid));
});

test('longest match wins and unmatched segments reach the converter', () => {
  const { api } = loadUserscript();
  const { tries } = api.buildDictionaryTries(data([['甲', '短'], ['甲乙', '长']]));
  const unmatched = [];
  const convert = text => { unmatched.push(text); return '[' + text + ']'; };
  assert.equal(api.applyDictionary('前甲乙中甲后', convert, tries.t2s), '[前]长[中]短[后]');
  assert.deepEqual(unmatched, ['前', '中', '后']);
});

test('replacements are final, identity rules preserve text, directions are independent', () => {
  const { api } = loadUserscript();
  const { tries } = api.buildDictionaryTries(data(
    [['甲', '乙'], ['乙', '丙'], ['保留', '保留']], [['甲', '反向']]
  ));
  assert.equal(api.applyDictionary('甲乙保留', text => text.toUpperCase(), tries.t2s), '乙丙保留');
  assert.equal(api.applyDictionary('甲', text => text, tries.s2t), '反向');
});

test('ASCII and supplementary Han sources pass the page precheck', () => {
  const { api } = loadUserscript({ dictionary: data([['ASCII', '替换'], ['𠀀', '汉字']]) });
  assert.equal(api.mayConvertText('ASCII'), true);
  assert.equal(api.safeConvert('ASCII'), '替换');
  assert.equal(api.mayConvertText('𠀀'), true);
  assert.equal(api.safeConvert('𠀀'), '汉字');
});

test('failed persistence preserves dictionary, compiled tries and non-Han precheck', () => {
  for (const [oldRules, newRules] of [
    [[['ASCII', '旧']], [['汉字', '新']]], [[['汉字', '旧']], [['ASCII', '新']]]
  ]) {
    const harness = loadUserscript({ dictionary: data(oldRules) });
    const before = harness.api.snapshot();
    harness.failWrites(new Error('模拟存储失败'));
    assert.throws(() => harness.api.saveDictionary(data(newRules)), /模拟存储失败/);
    const after = harness.api.snapshot();
    for (const key of Object.keys(before)) assert.equal(after[key], before[key]);
    assert.deepEqual(harness.storage.get('zh-t2s-dictionary'), data(oldRules));
    assert.equal(harness.api.safeConvert(oldRules[0][0]), '旧');
    assert.equal(harness.api.mayConvertText('ASCII'), oldRules[0][0] === 'ASCII');
    assert.equal(harness.scans, 0);
  }
});

test('failed save keeps the dialog and draft; retry installs the new dictionary', async () => {
  const harness = loadUserscript({ dictionary: data([['旧词', '旧结果']]) });
  const editor = harness.openEditor();
  editor.get(editorSelector('t2s')).value = 'ASCII => 新结果';
  harness.failWrites(new Error('模拟存储失败'));
  await editor.get(actionSelector('save')).click();
  assert.equal(editor.dialog.open, true);
  assert.equal(editor.get(editorSelector('t2s')).value, 'ASCII => 新结果');
  assert.match(editor.get('.status').textContent, /保存失败/);
  harness.failWrites(null);
  await editor.get(actionSelector('save')).click();
  assert.equal(editor.dialog.open, false);
  assert.equal(harness.api.mayConvertText('ASCII'), true);
  assert.equal(harness.api.safeConvert('ASCII'), '新结果');
  assert.ok(harness.scans > 0);
});

for (const field of ['t2s', 's2t', 'preview']) {
  test(field + ': composition cancels pending validation and resumes after completion', async () => {
    const harness = loadUserscript();
    const editor = harness.openEditor();
    const rules = editor.get(editorSelector('t2s'));
    const input = editor.get(field === 'preview' ? '[data-preview-input]' : editorSelector(field));
    rules.value = '原词 => 结果';
    await rules.fire('input', { isComposing: false });
    const staleTimer = [...harness.timers.values()].find(timer => timer.delay === 300);
    assert.ok(staleTimer);
    const before = editor.get('.status').textContent;
    await input.fire('compositionstart');
    assert.equal([...harness.timers.values()].filter(timer => timer.delay === 300).length, 0);
    rules.value = '半成品';
    await input.fire('input', { isComposing: true });
    staleTimer.fn(); // 即使回调意外被调用，也不应处理未完成的内容。
    assert.equal(editor.get('.status').textContent, before);
    rules.value = '原词 => 完成';
    await input.fire('compositionend');
    harness.runFeedback();
    assert.match(editor.get('.status').textContent, /已识别 1 条/);
  });
}

test('preview freezes during composition and updates when it ends', async () => {
  const harness = loadUserscript({ dictionary: data([['原词', '预览结果']]) });
  const editor = harness.openEditor();
  const input = editor.get('[data-preview-input]');
  input.value = '原词';
  await input.fire('input', { isComposing: false });
  assert.equal(editor.get('[data-preview-out]').textContent, '预览结果');
  await input.fire('compositionstart');
  input.value = '半成品';
  await input.fire('input', { isComposing: true });
  assert.equal(editor.get('[data-preview-out]').textContent, '预览结果');
  await input.fire('compositionend');
  assert.equal(editor.get('[data-preview-out]').textContent, '半成品');
  assert.deepEqual(harness.storage.get('zh-t2s-dictionary'), data([['原词', '预览结果']]));
});

for (const action of ['save', 'export', 'import']) {
  test(action + ': pending feedback cannot overwrite operation status', async () => {
    const harness = loadUserscript();
    const editor = harness.openEditor();
    const input = editor.get(editorSelector('t2s'));
    input.value = '原词 => 结果';
    await input.fire('input', { isComposing: false });
    if (action === 'save') harness.failWrites(new Error('模拟存储失败'));
    if (action === 'import') {
      const json = JSON.stringify(data([['导入词', '导入结果']]));
      editor.get('input[type="file"]').files = [{ size: Buffer.byteLength(json), text: async () => json }];
      await editor.get('input[type="file"]').fire('change');
    } else {
      await editor.get(actionSelector(action)).click();
    }
    const status = editor.get('.status').textContent;
    assert.match(status, action === 'save' ? /保存失败/ : action === 'import' ? /已导入/ : /已导出/);
    assert.equal([...harness.timers.values()].filter(timer => timer.delay === 300).length, 0);
    harness.runFeedback();
    assert.equal(editor.get('.status').textContent, status);
  });
}
