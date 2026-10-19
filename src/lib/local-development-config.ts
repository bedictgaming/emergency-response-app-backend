import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readLocalGoogleOAuthCredentials, type LocalGoogleOAuthCredentials } from './local-google-oauth';
import { readLocalCloudinaryCredentials, type LocalCloudinaryCredentials } from './local-cloudinary';

export type LocalDevelopmentConfig = {
  format: 'emergency-response-local-development-v1';
  databaseUrl: string;
  jwtSecret: string;
  port: 55432;
  runtime: string;
  data: string;
  executableHashes: Record<string, string>;
};
const fail: (ok: unknown, reason: string) => asserts ok = (ok, reason) => { if (!ok) throw new Error(reason); };
export function validateLocalDevelopmentConfig(value: LocalDevelopmentConfig, directory: string) {
  const root = path.resolve(directory);
  let url: URL;
  try { url = new URL(value.databaseUrl); }
  catch { throw new Error('LOCAL_DEVELOPMENT_IDENTITY_INVALID'); }
  fail(value.format === 'emergency-response-local-development-v1'
    && url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port === '55432'
    && url.pathname === '/emergency_response_dev' && url.username === 'er_local_app'
    && /^[a-f0-9]{64}$/.test(url.password) && !url.search && !url.hash
    && value.port === 55432 && /^[a-f0-9]{64}$/.test(value.jwtSecret), 'LOCAL_DEVELOPMENT_IDENTITY_INVALID');
  fail(path.resolve(value.runtime) === path.join(root, 'runtime') && path.resolve(value.data) === path.join(root, 'data'), 'LOCAL_DEVELOPMENT_PATH_INVALID');
  fail(['pg_ctl.exe', 'postgres.exe'].every(name => /^[a-f0-9]{64}$/.test(value.executableHashes[name] || '')), 'LOCAL_DEVELOPMENT_RUNTIME_PINS_MISSING');
  return value;
}
export function localDevelopmentEnvironment(config: LocalDevelopmentConfig, google?: LocalGoogleOAuthCredentials, photo?: LocalCloudinaryCredentials): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development', APP_NAME: 'Cordova Emergency Response (local development)', PORT: '8000',
    DATABASE_URL: config.databaseUrl, DIRECT_URL: config.databaseUrl, JWT_SECRET: config.jwtSecret,
    FRONTEND_URL: 'http://localhost:3000', BACKEND_URL: 'http://localhost:8000',
    ADDITIONAL_FRONTEND_ORIGINS: '', COOKIE_DOMAIN: '', TRUSTED_PROXY_CIDRS: '',
    API_GATEWAY_REQUIRED: 'false', API_GATEWAY_SECRET: '', API_GATEWAY_AUDIENCE: '',
    BACKGROUND_JOBS_ENABLED: 'false', EVIDENCE_NAMESPACE: 'emergency-incidents-development',
    EVIDENCE_DELETION_ENABLED: 'false', ORPHAN_EVIDENCE_SWEEP_ENABLED: 'false',
    RAILWAY_ENVIRONMENT_NAME: '', RAILWAY_ENVIRONMENT_ID: '',
    CLOUDINARY_CLOUD_NAME: photo?.cloudName ?? '', CLOUDINARY_API_KEY: photo?.apiKey ?? '', CLOUDINARY_API_SECRET: photo?.apiSecret ?? '',
    CLOUDINARY_URL: '', CLOUDINARY_ACCOUNT_URL: '', CLOUDINARY_API_PROXY: '',
    WEB_PUSH_PUBLIC_KEY: '', WEB_PUSH_PRIVATE_KEY: '', WEB_PUSH_SUBJECT: 'mailto:local@example.test',
    GOOGLE_CLIENT_ID: google?.clientId ?? 'local-development-unconfigured', GOOGLE_CLIENT_SECRET: google?.clientSecret ?? 'local-development-unconfigured',
    GEMINI_API_KEY: '', MAIL_PROVIDER: 'smtp', MAIL_FROM: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM: '',
    BREVO_API_KEY: '', RESEND_API_KEY: '', GMAIL_MAIL_CLIENT_ID: '', GMAIL_MAIL_CLIENT_SECRET: '', GMAIL_MAIL_REFRESH_TOKEN: '',
    MAIL_RELAY_URL: '', MAIL_RELAY_AUDIENCE: '', MAIL_RELAY_SECRET: '',
    ADMIN_BOOTSTRAP_EMAIL: '', ADMIN_BOOTSTRAP_PASSWORD: '', ADMIN_BOOTSTRAP_NAME: '', LOCAL_DEV_ACTIVE: 'true',
  };
}
export function configureLocalDevelopment(env: NodeJS.ProcessEnv = process.env) {
  if (!env.LOCAL_DEV_CONFIG_FILE) return;
  fail(env.NODE_ENV === 'development' && process.platform === 'win32' && env.USERPROFILE, 'LOCAL_DEVELOPMENT_MODE_REQUIRED');
  const root = path.join(env.USERPROFILE, '.emergency-response-local', 'development'), file = path.join(root, 'backend-private.json');
  fail(path.resolve(env.LOCAL_DEV_CONFIG_FILE).toLowerCase() === file.toLowerCase()
    && !root.toLowerCase().includes('onedrive') && realpathSync(root).toLowerCase() === root.toLowerCase()
    && !lstatSync(file).isSymbolicLink(), 'LOCAL_DEVELOPMENT_PRIVATE_PATH_REQUIRED');
  let privateConfig: LocalDevelopmentConfig;
  try { privateConfig = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('LOCAL_DEVELOPMENT_CONFIG_READ_FAILED'); }
  const config = validateLocalDevelopmentConfig(privateConfig, root);
  for (const name of ['pg_ctl.exe', 'postgres.exe']) {
    const executable = path.join(config.runtime, 'pgsql', 'bin', name);
    fail(!lstatSync(executable).isSymbolicLink()
      && createHash('sha256').update(readFileSync(executable)).digest('hex') === config.executableHashes[name], 'LOCAL_DEVELOPMENT_RUNTIME_CHANGED');
  }
  // Load only after the protected directory, local target and runtime pins pass.
  const google = readLocalGoogleOAuthCredentials(root);
  // Optional dedicated photo cloud; workers and all evidence deletion stay off.
  const photo = readLocalCloudinaryCredentials(root);
  const nativeEnv: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) if (env[name]) nativeEnv[name] = env[name];
  const ctl = path.join(config.runtime, 'pgsql', 'bin', 'pg_ctl.exe');
  const run = (args: string[]) => spawnSync(ctl, args, { cwd: root, env: nativeEnv, windowsHide: true, stdio: 'ignore', timeout: 45000 });
  const status = run(['status', '-D', config.data]);
  if (status.status !== 0) {
    fail(status.status === 3, 'LOCAL_DEVELOPMENT_DATABASE_STATUS_FAILED');
    const start = run(['start', '-D', config.data, '-l', path.join(root, 'postgres.log'), '-w', '-t', '30', '-o',
      '-h 127.0.0.1 -p 55432 -c unix_socket_directories= -c log_min_messages=panic -c log_min_error_statement=panic -c log_statement=none']);
    fail(start.status === 0, 'LOCAL_DEVELOPMENT_DATABASE_START_FAILED');
  }
  Object.assign(env, localDevelopmentEnvironment(config, google, photo));
}
