'use strict';

const assert = require('node:assert/strict');

function assertVersionNotOlder(current, baseline) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  assert.match(current, pattern, '当前版本须为 major.minor.patch。');
  assert.match(baseline, pattern, '基准版本须为 major.minor.patch。');
  const next = current.split('.').map(BigInt);
  const previous = baseline.split('.').map(BigInt);
  for (let i = 0; i < next.length; i++) {
    assert.ok(next[i] >= previous[i], '发布版本不能回退：' + baseline + ' → ' + current);
    if (next[i] > previous[i]) return;
  }
}

module.exports = { assertVersionNotOlder };
