'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadUserscript } = require('./userscript-harness.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const data = (t2s = [], s2t = []) => ({ t2s, s2t });
const editorSelector = direction => '[data-editor="' + direction + '"]';
const actionSelector = action => '[data-action="' + action + '"]';

test('state changes keep whitelisted pages inactive until removed from whitelist', () => {
  const harness = loadUserscript({ whitelist: ['example.test'] });
  for (const direction of ['s2t', 't2s', 'off', 't2s']) {
    harness.api.setState(direction);
    assert.equal(harness.api.effectiveState(), 'off');
    assert.equal(harness.scans, 0);
    assert.equal(harness.observations.length, 0);
  }
  assert.equal(harness.storage.get('zh-t2s-enabled'), 't2s');
  harness.api.toggleWhitelist();
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
