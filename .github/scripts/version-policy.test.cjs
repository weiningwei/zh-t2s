'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertVersionNotOlder } = require('./version-policy.cjs');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');

test('unchanged versions and SemVer upgrades are allowed', () => {
  for (const [current, baseline] of [
    ['2.13.1', '2.13.1'], ['2.13.2', '2.13.1'], ['2.14.0', '2.13.9'],
    ['3.0.0', '2.99.99'], ['2.10.0', '2.9.9']
  ]) assert.doesNotThrow(() => assertVersionNotOlder(current, baseline));
});

test('patch, minor and major rollbacks are rejected', () => {
  for (const [current, baseline] of [
    ['2.13.0', '2.13.1'], ['2.12.99', '2.13.1'], ['1.99.99', '2.0.0'],
    ['2.9.9', '2.10.0']
  ]) assert.throws(() => assertVersionNotOlder(current, baseline), /不能回退/);
});

test('invalid version formats are rejected on either side', () => {
  for (const invalid of ['2.13', '02.13.1', '2.13.1-beta', 'invalid']) {
    assert.throws(() => assertVersionNotOlder(invalid, '2.13.1'));
    assert.throws(() => assertVersionNotOlder('2.13.1', invalid));
  }
});

function runMetadataCheck(baselineSha, baselineVersion) {
  const checker = readFileSync(resolve(__dirname, 'check-userscript.cjs'), 'utf8');
  let compared = false;
  runInNewContext(checker, {
    __dirname, console: { log() {} }, process: { env: { BASELINE_SHA: baselineSha } },
    require(name) {
      if (name !== 'node:child_process') return require(name);
      return { execFileSync(command, args) {
        assert.equal(command, 'git');
        assert.deepEqual(Array.from(args), ['show', baselineSha + ':zh-t2s.user.js']);
        compared = true;
        return '// @version ' + baselineVersion + '\n';
      } };
    }
  }, { filename: 'check-userscript.cjs', timeout: 1000 });
  return compared;
}

test('metadata checker rejects rollback even when all current version files agree', () => {
  assert.throws(() => runMetadataCheck('a'.repeat(40), '999999.0.0'), /不能回退/);
  assert.equal(runMetadataCheck('a'.repeat(40), '0.0.0'), true);
});

test('missing and first-push baselines skip comparison; invalid SHA is rejected', () => {
  assert.equal(runMetadataCheck(undefined), false);
  assert.equal(runMetadataCheck('0'.repeat(40)), false);
  assert.throws(() => runMetadataCheck('not-a-sha'), /完整提交 SHA/);
});
