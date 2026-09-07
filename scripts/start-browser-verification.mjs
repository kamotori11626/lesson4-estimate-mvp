import crypto from 'node:crypto';
import fs from 'node:fs';
import { hashPassword } from '../src/password.mjs';

const credentialPath = '/private/tmp/lesson4-browser-verification.json';
const username = `browser-check-${crypto.randomBytes(4).toString('hex')}`;
const password = crypto.randomBytes(24).toString('base64url');

Object.assign(process.env, {
  APP_ENV: 'development', HOST: '127.0.0.1', PORT: '4173', APP_ORIGIN: 'http://127.0.0.1:4173',
  DEMO_DATA_ONLY: 'true', DEMO_USERNAME: username, DEMO_DISPLAY_NAME: 'Chrome確認用メンター',
  DEMO_PASSWORD_HASH: await hashPassword(password), SESSION_SECRET: crypto.randomBytes(48).toString('base64url'),
  AI_PROVIDER: 'mock', GEMINI_API_KEY: ''
});
fs.writeFileSync(credentialPath, JSON.stringify({ username, password }), { mode: 0o600 });
process.on('exit', () => { try { fs.unlinkSync(credentialPath); } catch {} });
console.log('browser verification server starting (Gemini disabled)');
await import('../src/server.mjs');
