import { spawnSync } from 'node:child_process';

function audit(args) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const argv = process.platform === 'win32' ? ['/d', '/s', '/c', `npm audit --json ${args}`] : ['audit', '--json', ...args.split(' ').filter(Boolean)];
  const result = spawnSync(command, argv, { encoding: 'utf8' });
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('Dependency audit unavailable'); }
  if (data.error || !data.vulnerabilities) throw new Error('Dependency audit unavailable');
  return data;
}
const runtime = audit('--omit=dev');
if (Object.keys(runtime.vulnerabilities).length) throw new Error('Runtime dependency advisories require review');
const full = audit('');
const allowed = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const findings = Object.values(full.vulnerabilities);
const advisories = findings.flatMap(item => item.via.filter(via => typeof via === 'object'));
if (findings.length && (!advisories.length || advisories.some(item => item.url !== allowed))) throw new Error('New build dependency advisory requires review');
if (findings.length && Date.now() >= Date.parse('2026-10-17T00:00:00Z')) throw new Error('Temporary braces advisory exception expired; review upstream and renew explicitly or fix');
console.log(JSON.stringify({ runtimeAdvisories: 0, buildAffectedPackages: findings.length, reviewBy: findings.length ? '2026-10-17' : null }));
if (findings.length) console.warn('Known unpatched build-only braces advisory remains. Do not process untrusted glob patterns or represent this as fixed: ' + allowed);
