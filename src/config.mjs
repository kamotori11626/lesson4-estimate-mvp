import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const envPath = path.join(projectDir, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildConfig(env = process.env, baseDir = projectDir) {
  const environment = env.APP_ENV || env.NODE_ENV || 'development';
  const production = environment === 'production';
  const port = number(env.PORT, 4173);
  const appOriginText = env.APP_ORIGIN || `http://127.0.0.1:${port}`;
  let appOrigin = null;
  try { appOrigin = new URL(appOriginText); } catch { /* validated at startup */ }
  const sslMode = env.DATABASE_SSL_MODE || (production ? 'verify-full' : 'disable');
  const databaseUrl = env.DATABASE_URL || '';
  const pgConfig = databaseUrl
    ? { connectionString: databaseUrl, ssl: sslMode === 'disable' ? false : { rejectUnauthorized: true } }
    : {
        host: path.resolve(baseDir, env.PGHOST || '.postgres/socket'),
        port: number(env.PGPORT, 55432),
        user: env.PGUSER || 'mvp_user',
        password: env.PGPASSWORD || undefined,
        database: env.PGDATABASE || 'lesson4_mvp',
        ssl: sslMode === 'disable' ? false : { rejectUnauthorized: true }
      };

  return {
    environment,
    production,
    port,
    bindHost: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    appOrigin,
    pg: pgConfig,
    database: { usesUrl: Boolean(databaseUrl), sslMode },
    auth: {
      username: env.DEMO_USERNAME || '',
      displayName: env.DEMO_DISPLAY_NAME || '',
      passwordHash: env.DEMO_PASSWORD_HASH || '',
      sessionSecret: env.SESSION_SECRET || '',
      sessionTtlMinutes: number(env.SESSION_TTL_MINUTES, 480),
      maxFailures: number(env.LOGIN_MAX_FAILURES, 5),
      failureWindowMinutes: number(env.LOGIN_FAILURE_WINDOW_MINUTES, 15),
      lockMinutes: number(env.LOGIN_LOCK_MINUTES, 15)
    },
    demo: {
      dataOnly: bool(env.DEMO_DATA_ONLY, false),
      dataAsOf: env.DEMO_DATA_AS_OF || '2026-09-06'
    },
    ai: {
      provider: env.AI_PROVIDER || 'gemini',
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
    }
  };
}

export function validateRuntimeConfig(value) {
  const errors = [];
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) errors.push('PORTが不正です。');
  if (!value.appOrigin || value.appOrigin.username || value.appOrigin.password || value.appOrigin.pathname !== '/' || value.appOrigin.search || value.appOrigin.hash) errors.push('APP_ORIGINはオリジンだけを指定してください。');
  if (!['disable', 'verify-full'].includes(value.database.sslMode)) errors.push('DATABASE_SSL_MODEはdisableまたはverify-fullを指定してください。');
  if (!value.auth.username || !value.auth.displayName || !value.auth.passwordHash || value.auth.sessionSecret.length < 32) errors.push('認証用環境変数が不足しています。');
  if (value.production) {
    if (value.bindHost !== '0.0.0.0') errors.push('本番環境のHOSTは0.0.0.0である必要があります。');
    if (value.appOrigin?.protocol !== 'https:') errors.push('本番環境のAPP_ORIGINはHTTPSである必要があります。');
    if (!value.database.usesUrl) errors.push('本番環境ではDATABASE_URLが必要です。');
    if (!value.demo.dataOnly) errors.push('本番デモ環境ではDEMO_DATA_ONLY=trueが必要です。');
  }
  if (errors.length) throw new Error(`起動設定エラー: ${errors.join(' ')}`);
}

loadDotEnv();
export const config = buildConfig();
