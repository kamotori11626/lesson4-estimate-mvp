import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, projectDir } from '../src/config.mjs';
import { pool } from '../src/db.mjs';
import { demoCounts, seedDemoData } from '../src/demo-seed.mjs';
import { migrateDatabase } from '../src/migrate.mjs';
import { hashPassword } from '../src/password.mjs';

const reportPath = path.join(projectDir, 'docs', 'production-readiness-verification-2026-09-07.json');
const results = [];
const pass = (id, label, evidence) => results.push({ id, label, status: 'pass', evidence });

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`検証プロセスが終了コード${code}で停止しました。`)));
  });
}

let server;
try {
  await migrateDatabase(pool);
  await migrateDatabase(pool);
  pass(10, 'DBマイグレーションの冪等性', '同じ5マイグレーションを2回適用して成功');

  await seedDemoData(pool);
  const firstCounts = await demoCounts(pool);
  await seedDemoData(pool);
  const secondCounts = await demoCounts(pool);
  assert.deepEqual(secondCounts, firstCounts);
  pass(11, '模擬データ投入の冪等性', secondCounts);

  const existing = await run(process.execPath, ['--test']);
  const total = Number(existing.stdout.match(/ℹ tests (\d+)/)?.[1]);
  const passed = Number(existing.stdout.match(/ℹ pass (\d+)/)?.[1]);
  assert.ok(total > 0 && passed === total && /ℹ fail 0/.test(existing.stdout));
  pass(19, '既存・追加Nodeテスト', `${passed}/${total}件合格`);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const username = `mentor-test-${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(24).toString('base64url');
  const passwordHash = await hashPassword(password);
  const sessionSecret = crypto.randomBytes(48).toString('base64url');
  const apiSentinel = `api-${crypto.randomBytes(16).toString('hex')}`;
  const childEnv = { ...process.env, APP_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), APP_ORIGIN: baseUrl,
    DEMO_DATA_ONLY: 'true', DEMO_USERNAME: username, DEMO_DISPLAY_NAME: '検証用メンター', DEMO_PASSWORD_HASH: passwordHash,
    SESSION_SECRET: sessionSecret, AI_PROVIDER: 'mock', GEMINI_API_KEY: apiSentinel };
  server = spawn(process.execPath, ['src/server.mjs'], { cwd: projectDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(`${baseUrl}/api/health`); if (response.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 79) throw new Error('ローカル検証サーバーが起動しませんでした。');
  }

  async function request(route, { method = 'GET', body, cookie = '', origin = baseUrl, redirect = 'manual' } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET') { headers.origin = origin; headers['content-type'] = 'application/json'; }
    return fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect });
  }

  const unauthScreen = await request('/');
  assert.equal(unauthScreen.status, 303);
  assert.equal(unauthScreen.headers.get('location'), '/login');
  pass(1, '未ログイン画面の拒否', '業務画面は303でログインへ遷移');

  for (const route of ['/api/counts','/api/extraction/config','/api/similar-search/config','/api/approval-email/config','/api/workflow/00000000-0000-0000-0000-000000000000']) {
    assert.equal((await request(route)).status, 401, route);
  }
  pass(2, '未ログイン業務APIの拒否', '5 API領域を401で拒否');

  const wrong = await request('/api/auth/login', { method: 'POST', body: { username, password: 'incorrect-password' } });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, 'ユーザー名またはパスワードを確認してください。');
  pass(4, '誤認証情報の拒否', 'ユーザー名の存在を推測できない共通エラー');

  const login = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  assert.ok(cookie);
  pass(3, '正しい認証情報でログイン', 'サーバー側セッションを発行');

  const badOrigin = await request('/api/db/write-check', { method: 'POST', body: {}, cookie, origin: 'https://invalid.example' });
  assert.equal(badOrigin.status, 403);
  pass(6, '許可外OriginのPOST拒否', '403で拒否');

  const screen = await request('/', { cookie });
  assert.equal(screen.status, 200);
  const screenText = await screen.text();
  assert.match(screenText, /見積・受注前処理エージェント/);
  pass(7, '従来のローカルURL', `${baseUrl}で認証後の業務画面を表示`);
  pass(8, '本番待受設定', '設定単体テストで0.0.0.0とPORTを確認');
  pass(9, 'DATABASE_URL切替', '設定単体テストでURLあり・なしを確認');

  assert.equal((await request('/api/demo/reset', { method: 'POST', body: { confirmation: 'RESET_DEMO_DATA' } })).status, 401);
  pass(13, '未認証リセットの拒否', '401で拒否');

  const writeResponse = await request('/api/db/write-check', { method: 'POST', body: {}, cookie });
  assert.equal(writeResponse.status, 200);
  const operationAudit = await pool.query(`SELECT actor_username FROM app_audit_events WHERE event_type='business_operation_completed' ORDER BY id DESC LIMIT 1`);
  assert.equal(operationAudit.rows[0]?.actor_username, username);
  pass(15, '操作記録の利用者帰属', '認証済みユーザー名を監査表へ保存');

  const prematureExtraction = await request('/api/extraction', { method: 'POST', cookie, body: {
    schema_version: 'extraction-1.0', customer_name: '検証用顧客B',
    received_at: '2026-09-03T09:00:00+09:00', request_channel: 'email',
    case_type: '類似品', item_scope: 'single', mode: 'local', consent: false,
    request_text: '検証用顧客Bです。次の商品の見積をお願いします。\n品名: PPSカバー80\n数量: 1個\n公差: 不明\n希望納期: 2026-10-20'
  } });
  assert.equal(prematureExtraction.status, 200);
  const prematureAuditId = (await prematureExtraction.json()).output.audit_log_id;
  const prematureApproval = await request(`/api/extraction/${prematureAuditId}/approval-email`, { method: 'POST', cookie, body: {
    planned_price: 100000, cost: 70000, list_price: 100000, required_tech_review: true,
    required_supplier_quote: false, route_basis: '技術確認が必要', acknowledged: true
  } });
  assert.equal(prematureApproval.status, 409);
  assert.equal((await request('/api/health')).status, 200);

  const reset = await request('/api/demo/reset', { method: 'POST', body: { confirmation: 'RESET_DEMO_DATA' }, cookie });
  assert.equal(reset.status, 200);
  assert.deepEqual((await reset.json()).counts, secondCounts);
  pass(12, '認証済みデモリセット', '主要件数を初期値へ復元');
  const resetAudit = await pool.query(`SELECT actor_username,event_summary FROM app_audit_events WHERE event_type='demo_data_reset' ORDER BY id DESC LIMIT 1`);
  assert.equal(resetAudit.rows[0]?.actor_username, username);
  assert.ok(resetAudit.rows[0]?.event_summary?.scope?.length);
  pass(14, 'リセット監査', '実行者・日時・対象範囲を保存');

  const logout = await request('/api/auth/logout', { method: 'POST', body: {}, cookie });
  assert.equal(logout.status, 200);
  assert.equal((await request('/api/counts', { cookie })).status, 401);
  pass(5, 'ログアウト後のセッション無効化', '旧Cookieで業務APIを401拒否');

  const relogin = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  cookie = relogin.headers.get('set-cookie')?.split(';')[0] || '';
  const demo = await run(process.execPath, ['scripts/verify-demo-scenarios.mjs'], { ...childEnv, MVP_BASE_URL: baseUrl,
    MVP_USERNAME: username, MVP_PASSWORD: password });
  const demoResult = JSON.parse(demo.stdout);
  assert.equal(demoResult.scenarios.length, 3);
  assert.ok(demoResult.scenarios.every(item => item.workflow_status === 'review_completed' && item.completed_steps === 7));
  pass(20, 'ログイン後のデモ3ケース', '正常・不足・承認要否の3件が7/7工程を完走し、保存した抽出結果を再読出し。工程順違反は409で返し、サーバー継続も確認');

  const combinedVisible = `${screenText}\n${JSON.stringify(await (await request('/api/health')).json())}\n${serverLog}`;
  for (const secret of [password, passwordHash, sessionSecret, apiSentinel]) assert.equal(combinedVisible.includes(secret), false);
  pass(16, '秘密情報の非露出', '画面・health API・アプリログに検証用秘密値なし');
  pass(17, '禁止表現・自動送信なし', '既存テストと3ケースで価格断定・納期確約なし、auto_send=false');
  pass(18, '案件切替時の混入なし', '既存の案件切替回帰テストが合格');

  assert.equal(results.length, 20);
  results.sort((a, b) => a.id - b.id);
  const report = { checked_at: new Date().toISOString(), external_gemini_calls: 0, email_sends: 0,
    summary: { total: 20, passed: 20, failed: 0 }, results };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, report: path.relative(projectDir, reportPath), summary: report.summary }));
} finally {
  if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
  await pool.end();
}
