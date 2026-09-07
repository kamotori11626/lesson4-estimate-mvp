import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, validateRuntimeConfig } from '../src/config.mjs';
import { hashPassword, verifyPassword } from '../src/password.mjs';
import { sessionCookie } from '../src/auth.mjs';
import { validateRequestBoundary } from '../src/request-security.mjs';

const auth = { username: 'mentor', displayName: 'Mentor', passwordHash: 'x', sessionSecret: 's'.repeat(32) };

test('ローカルは127.0.0.1:4173とソケットDB、本番は0.0.0.0・PORT・DATABASE_URLへ切り替わる', () => {
  const local = buildConfig({}, '/tmp/project');
  assert.equal(local.bindHost, '127.0.0.1');
  assert.equal(local.port, 4173);
  assert.equal(local.database.usesUrl, false);
  assert.match(local.pg.host, /\.postgres\/socket$/);
  const production = buildConfig({ APP_ENV: 'production', PORT: '10000', APP_ORIGIN: 'https://demo.example',
    DATABASE_URL: 'postgresql://user:password@db.internal/example', DATABASE_SSL_MODE: 'disable', DEMO_DATA_ONLY: 'true',
    DEMO_USERNAME: auth.username, DEMO_DISPLAY_NAME: auth.displayName, DEMO_PASSWORD_HASH: auth.passwordHash,
    SESSION_SECRET: auth.sessionSecret }, '/tmp/project');
  validateRuntimeConfig(production);
  assert.equal(production.bindHost, '0.0.0.0');
  assert.equal(production.port, 10000);
  assert.equal(production.database.usesUrl, true);
  assert.equal(production.pg.connectionString.startsWith('postgresql://'), true);
});

test('本番の非HTTPS Origin・DATABASE_URLなし・デモ安全スイッチなしを拒否する', () => {
  const bad = buildConfig({ APP_ENV: 'production', APP_ORIGIN: 'http://demo.example', DEMO_USERNAME: auth.username,
    DEMO_DISPLAY_NAME: auth.displayName, DEMO_PASSWORD_HASH: auth.passwordHash, SESSION_SECRET: auth.sessionSecret });
  assert.throws(() => validateRuntimeConfig(bad), /HTTPS.*DATABASE_URL.*DEMO_DATA_ONLY/s);
});

test('Host・Origin・クロスサイトPOSTを固定の許可Originだけに限定する', () => {
  const settings = buildConfig({ APP_ORIGIN: 'http://127.0.0.1:4173' });
  const valid = { method: 'POST', headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173',
    'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } };
  assert.doesNotThrow(() => validateRequestBoundary(valid, settings));
  assert.throws(() => validateRequestBoundary({ ...valid, headers: { ...valid.headers, host: 'evil.example' } }, settings), /許可されたURL/);
  assert.throws(() => validateRequestBoundary({ ...valid, headers: { ...valid.headers, origin: 'https://evil.example' } }, settings), /許可された画面/);
  assert.throws(() => validateRequestBoundary({ ...valid, headers: { ...valid.headers, origin: undefined } }, settings), /同じ画面/);
  assert.doesNotThrow(() => validateRequestBoundary({
    method: 'GET',
    headers: { host: '127.0.0.1:4173', 'sec-fetch-site': 'cross-site' }
  }, settings));
  assert.throws(() => validateRequestBoundary({
    ...valid,
    headers: { ...valid.headers, 'sec-fetch-site': 'cross-site' }
  }, settings), /別サイト/);
});

test('パスワードはscryptハッシュで照合し、Cookieは本番で安全属性と期限を持つ', async () => {
  const encoded = await hashPassword('temporary-test-password');
  assert.equal(await verifyPassword('temporary-test-password', encoded), true);
  assert.equal(await verifyPassword('wrong-password', encoded), false);
  const settings = { production: true, auth: { sessionTtlMinutes: 480 } };
  const cookie = sessionCookie('opaque-token', settings);
  for (const expected of ['HttpOnly','Secure','SameSite=Strict','Max-Age=28800']) assert.match(cookie, new RegExp(expected));
});
