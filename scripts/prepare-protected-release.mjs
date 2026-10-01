// Operator-only paired release preparation. No migrations or report/evidence writes.
// Platform secrets are read/written in memory and never returned as command output.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const railway = 'C:/Users/Lenovo/AppData/Roaming/npm/node_modules/@railway/cli/bin/railway.exe';
const vercel = process.env.PROTECTED_RELEASE_VERCEL_CLI;
const projectId = 'prj_EoB1SDCIdo2thmzHpsJb1kQmuDtO';
const teamId = 'team_7hzszkBHGcKbXib53zlbRd8E';
const project = 'b564a426-c668-4a89-9b37-6cec044c43f0';
const productionService = 'c4b8b37e-b8bd-46c4-aee3-0deb90f1d41e';
const productionEnvironment = '65e6e7d8-4d68-40ed-9de5-315f7451ca5b';
const frontend = resolve('../emergency-response-app-frontend');
const api = `/v9/projects/${projectId}?teamId=${teamId}`;
function must(condition, label) { if (!condition) throw new Error(label); }
async function command(executable, args, { cwd, input, timeout = 180000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true });
    let output = '', size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('PLATFORM_COMMAND_TIMEOUT')); }, timeout);
    child.stdout.on('data', data => { size += data.length; if (size < 2_000_000) output += data; });
    child.stderr.on('data', () => {}); // Avoid any platform credential/config echo.
    child.on('error', () => { clearTimeout(timer); reject(new Error('PLATFORM_COMMAND_FAILED')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && size < 2_000_000 ? resolve(output) : reject(new Error('PLATFORM_COMMAND_FAILED')); });
    child.stdin.end(input);
  });
}
async function vc(args, options = {}) { return command(process.execPath, [vercel, ...args], { cwd: frontend, ...options }); }
async function vars(service, environment) {
  return JSON.parse(await command(railway, ['variable', 'list', '--service', service, '--environment', environment, '--project', project, '--json']));
}
try {
  must(vercel, 'VERCEL_CLI_REQUIRED');
  const settings = JSON.parse(await vc(['api', api, '--method', 'GET', '--raw']));
  must(settings.id === projectId && settings.ssoProtection?.deploymentType === 'all', 'ALL_DEPLOYMENTS_PROTECTION_REQUIRED');
  const production = await vars(productionService, productionEnvironment);
  const staging = await vars('api-staging', 'staging');
  must(production.RAILWAY_SERVICE_ID === productionService && production.RAILWAY_ENVIRONMENT_ID === productionEnvironment
    && new URL(production.DATABASE_URL).pathname === '/neondb'
    && production.FRONTEND_URL === 'https://cordova-emergency-response.vercel.app'
    && production.BACKEND_URL === 'https://cordova-emergency-response.vercel.app'
    && !production.TRUSTED_PROXY_CIDRS, 'PRODUCTION_TARGET_MISMATCH');
  must(staging.EVIDENCE_NAMESPACE === 'emergency-incidents-staging' && staging.BACKGROUND_JOBS_ENABLED === 'false'
    && staging.EVIDENCE_DELETION_ENABLED === 'false' && staging.ORPHAN_EVIDENCE_SWEEP_ENABLED === 'false', 'STAGING_CONTAINMENT_REQUIRED');
  const secret = production.API_GATEWAY_SECRET || randomBytes(32).toString('hex');
  must(secret.length >= 32 && secret !== staging.API_GATEWAY_SECRET && secret !== production.JWT_SECRET, 'DEDICATED_PRODUCTION_SECRET_REQUIRED');
  await command(railway, ['variable', 'set', 'API_GATEWAY_SECRET', '--stdin', '--skip-deploys', '--service', productionService,
    '--environment', productionEnvironment, '--project', project], { input: secret });
  await command(railway, ['variable', 'set', 'API_GATEWAY_REQUIRED=false', 'API_GATEWAY_AUDIENCE=emergency-response-production-v1',
    'BACKGROUND_JOBS_ENABLED=true', 'EVIDENCE_NAMESPACE=emergency-incidents', 'EVIDENCE_DELETION_ENABLED=false',
    'ORPHAN_EVIDENCE_SWEEP_ENABLED=false', '--skip-deploys', '--service', productionService,
    '--environment', productionEnvironment, '--project', project]);
  console.log(JSON.stringify({ productionVariablesPrepared: true, gatewayEnforcementNotYetActivated: true,
    noSchemaOrApplicationDataChanges: true }));
  const config = {
    NEXT_PUBLIC_API_URL: 'https://cordova-emergency-response.vercel.app', NEXT_PUBLIC_PUBLIC_LAUNCH: 'true',
    NEXT_PUBLIC_PRODUCTION_VALIDATION: 'false', NEXT_PUBLIC_PREVIEW_ONLY: 'false', NEXT_PUBLIC_STAGING_TEST: 'false',
    API_GATEWAY_UPSTREAM: 'https://api-production-49dea.up.railway.app', API_GATEWAY_AUDIENCE: 'emergency-response-production-v1',
    API_GATEWAY_SECRET: secret,
  };
  for (const [key, value] of Object.entries(config)) {
    await vc(['env', 'add', key, 'production', '--force', '--yes', '--project', projectId,
      key === 'API_GATEWAY_SECRET' ? '--sensitive' : '--no-sensitive'], { input: value });
  }
  console.log(JSON.stringify({ productionOnlyVercelEnvironmentSaved: true, previewSecretNotChanged: true }));
  const args = ['deploy', '--prod', '--skip-domain', '--yes', '--force', '--scope', 'benedict-mequiabas-projects'];
  for (const [key, value] of Object.entries(config)) {
    args.push('--env', `${key}=${value}`);
    if (key.startsWith('NEXT_PUBLIC_')) args.push('--build-env', `${key}=${value}`);
  }
  args.push('--meta', 'release=2026-10-01-protected-gateway-candidate');
  const deployed = await vc(args, { timeout: 1200000 });
  const url = deployed.match(/https:\/\/emergency-response-[a-z0-9]+-benedict-mequiabas-projects\.vercel\.app/)?.[0];
  must(url, 'CANDIDATE_DEPLOYMENT_URL_MISSING');
  console.log(JSON.stringify({ protectedProductionCandidate: url, productionAliasNotPromoted: true, publicAccessNotEnabled: true }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, reason: /^[A-Z_]{1,80}$/.test(error.message || '') ? error.message : 'RELEASE_PREPARATION_FAILED' }));
  process.exitCode = 1;
}
