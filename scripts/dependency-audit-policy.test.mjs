import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./check-dependency-audit.mjs', import.meta.url), 'utf8')
  .replace("import { spawnSync } from 'node:child_process';", '');
const advisory = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const expires = '2026-10-19T15:59:00Z';
const empty = { vulnerabilities: {} };
const finding = url => ({ vulnerabilities: { braces: { via: [{ url }] } } });
function execute({ runtime = empty, full = finding(advisory), time = '2026-10-17T12:00:00Z', unavailable = false } = {}) {
  const calls = [], logs = [];
  class Clock extends Date { static now() { return Date.parse(time); } }
  runInNewContext(source, { Date: Clock, process: { platform: 'linux' }, console: { log: value => logs.push(JSON.parse(value)), warn() {} },
    spawnSync: (_executable, args) => {
      calls.push(args);
      return { stdout: unavailable ? 'unavailable' : JSON.stringify(calls.length === 1 ? runtime : full) };
    },
  });
  return { calls, logs };
}

test('only the reviewed build advisory is temporarily allowed with the exact approved deadline', () => {
  const result = execute();
  assert.equal(result.calls[0].includes('--omit=dev'), true);
  assert.deepEqual(result.logs, [{ runtimeAdvisories: 0, buildAffectedPackages: 1, reviewBy: expires }]);
});
test('the exception expires at the approved instant, not after it', () => {
  assert.throws(() => execute({ time: expires }), /exception expired/);
  assert.throws(() => execute({ time: '2026-10-20T00:00:00Z' }), /exception expired/);
});
test('even the reviewed advisory is never allowed in the production-runtime graph', () => {
  assert.throws(() => execute({ runtime: finding(advisory) }), /Runtime dependency advisories/);
});
test('unrelated build advisories remain failures during the review window', () => {
  assert.throws(() => execute({ full: finding('https://github.com/advisories/GHSA-synthetic-new-advisory') }), /New build dependency advisory/);
});
test('an unavailable audit cannot become a passing review', () => {
  assert.throws(() => execute({ unavailable: true }), /audit unavailable/);
  assert.throws(() => execute({ runtime: { error: { code: 'SYNTHETIC_UNAVAILABLE' } } }), /audit unavailable/);
});
test('unidentified build findings cannot use this exception', () => {
  assert.throws(() => execute({ full: { vulnerabilities: { dependency: { via: ['unknown'] } } } }), /New build dependency advisory/);
});
test('a clear graph does not require an exception after the deadline', () => {
  assert.deepEqual(execute({ full: empty, time: '2026-10-20T00:00:00Z' }).logs,
    [{ runtimeAdvisories: 0, buildAffectedPackages: 0, reviewBy: null }]);
});

