'use strict';

// 静态检查，不执行用户脚本，也不请求 CDN。
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertVersionNotOlder } = require('./version-policy.cjs');

const repoRoot = resolve(__dirname, '../..');
const read = (file) => readFileSync(resolve(repoRoot, file), 'utf8');
const source = read('zh-t2s.user.js');
const header = source.match(/^\/\/ ==UserScript==\r?\n([\s\S]*?)^\/\/ ==\/UserScript==\r?$/m);
assert.ok(header && header.index === 0, '脚本必须以完整的 UserScript 元数据块开头。');

const fields = new Map();
for (const line of header[1].split(/\r?\n/)) {
  const match = line.match(/^\/\/\s+@(\S+)(?:[ \t]+(.*))?$/);
  if (!match) continue;
  const [, key, rawValue = ''] = match;
  if (!fields.has(key)) fields.set(key, []);
  fields.get(key).push(rawValue.trim());
}

function single(key) {
  const values = fields.get(key) || [];
  assert.equal(values.length, 1, '@' + key + ' 必须且只能出现一次。');
  return values[0];
}

for (const key of ['name', 'namespace', 'description', 'license']) {
  assert.ok(single(key), '@' + key + ' 不能为空。');
}
assert.equal(single('match'), '*://*/*', '@match 应保持全站匹配。');
assert.equal(single('run-at'), 'document-idle', '@run-at 应为 document-idle。');
assert.equal(single('noframes'), '', '必须保留不带值的 @noframes。');
assert.match(single('require'),
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/opencc-js@\d+\.\d+\.\d+\/dist\/umd\/full\.js$/,
  '@require 必须使用固定版本的 jsDelivr opencc-js UMD full.js。');
assert.deepEqual([...(fields.get('grant') || [])].sort(), [
  'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM_setValue', 'GM_getValue'
].sort(), '@grant 必须包含且仅包含当前使用的四项 GM API。');

const version = single('version');
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  '@version 必须使用 major.minor.patch 发布版本。');
const badge = read('README.md').match(/https:\/\/img\.shields\.io\/badge\/version-([\d.]+)-green/);
assert.ok(badge, 'README 缺少版本徽章。');
assert.equal(badge[1], version, 'README 版本徽章与 @version 不一致。');

// Unreleased 可以保留开发记录；只比较最新的已发布条目。
const releaseHeadings = [...read('CHANGELOG.md').matchAll(/^## \[([^\]\r\n]+)\]([^\r\n]*)$/gm)]
  .filter((match) => match[1] !== 'Unreleased');
assert.ok(releaseHeadings.length, 'CHANGELOG 缺少发布条目。');
assert.equal(releaseHeadings[0][1], version, 'CHANGELOG 最新发布版本与 @version 不一致。');
assert.match(releaseHeadings[0][2], /^ - \d{4}-\d{2}-\d{2}$/,
  'CHANGELOG 最新发布条目必须带 YYYY-MM-DD 日期。');

const baselineSha = process.env.BASELINE_SHA;
if (baselineSha && !/^0+$/.test(baselineSha)) {
  assert.match(baselineSha, /^[a-f0-9]{40}$/i, 'BASELINE_SHA 必须为完整提交 SHA。');
  const baselineSource = execFileSync('git', ['show', baselineSha + ':zh-t2s.user.js'], {
    cwd: repoRoot, encoding: 'utf8'
  });
  const baselineVersion = baselineSource.match(/^\/\/\s+@version[ \t]+(\d+\.\d+\.\d+)[ \t]*\r?$/m);
  assert.ok(baselineVersion, '基准提交缺少有效 @version。');
  assertVersionNotOlder(version, baselineVersion[1]);
  console.log('版本防回退检查通过：' + baselineVersion[1] + ' → ' + version);
} else {
  console.log('未提供基准提交（本地、手动运行或首次推送），跳过版本防回退检查。');
}

console.log('元数据与发布版本检查通过：' + version);
