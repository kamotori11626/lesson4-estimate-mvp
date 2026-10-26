import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { aiStatus, testAi } from './ai.mjs';
import { createAuth } from './auth.mjs';
import { config, projectDir, validateRuntimeConfig } from './config.mjs';
import { getCounts, pool, searchEntities, writeCheck } from './db.mjs';
import { seedDemoData, demoCounts } from './demo-seed.mjs';
import { createExtractionStore } from './extraction-store.mjs';
import { createExtractionService } from './extraction-service.mjs';
import { ExtractionError } from './extraction.mjs';
import { FIELD_LABELS, MAX_TEXT_LENGTH, OUTPUT_SCHEMA, SCHEMA_VERSION } from './extraction-schema.mjs';
import { SAMPLES } from './extraction-samples.mjs';
import { readJson } from './json-body.mjs';
import { BUSINESS_VERSION, TOPICS, REVIEW_STATES } from './business-review.mjs';
import { createSimilarSearchStore } from './similar-search-store.mjs';
import { createSimilarSearchService } from './similar-search-service.mjs';
import { SEARCH_RULE_VERSION, SEARCH_SCHEMA_VERSION, SEARCH_TEST_QUERIES } from './similar-search.mjs';
import { createApprovalEmailStore } from './approval-email-store.mjs';
import { createApprovalEmailService } from './approval-email-service.mjs';
import { createWorkflowStore } from './workflow-store.mjs';
import { createWorkflowService } from './workflow.mjs';
import { runAsUser } from './request-context.mjs';
import { safeRoute, validateRequestBoundary } from './request-security.mjs';

validateRuntimeConfig(config);

const extractionStore = createExtractionStore(pool);
const extraction = createExtractionService({ store: extractionStore, ai: config.ai });
const similarSearch = createSimilarSearchService({ extractionStore, store: createSimilarSearchStore(pool) });
const approvalEmail = createApprovalEmailService({ extractionStore, similarSearch,
  store: createApprovalEmailStore(pool), ai: config.ai });
const workflow = createWorkflowService({ store: createWorkflowStore(pool) });
const auth = createAuth(pool, config);

const publicDir = path.join(projectDir, 'public');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const publicFiles = new Set(['login.html', 'login.js', 'styles.css']);
const protectedFiles = new Set(['index.html', 'app.js', 'workflow.js', 'workflow-navigation.js', 'extraction.js', 'approval-email.js', 'approval-view.js']);
const allowedTypes = new Set(['customer', 'product', 'quote', 'request', 'supplier']);

function securityHeaders(type = 'application/json; charset=utf-8') {
  return {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  };
}

function json(response, status, body, extra = {}) {
  response.writeHead(status, { ...securityHeaders(), ...extra });
  response.end(JSON.stringify(body));
}

function redirect(response, location) {
  response.writeHead(303, { ...securityHeaders('text/plain; charset=utf-8'), location });
  response.end('Redirecting');
}

async function file(response, name) {
  const content = await fs.readFile(path.join(publicDir, name));
  response.writeHead(200, securityHeaders(contentTypes[path.extname(name)] || 'application/octet-stream'));
  response.end(content);
}

async function businessJson(request, response, user, status, body) {
  if (request.method === 'POST') await auth.audit('business_operation_completed', user,
    { method: request.method, route: safeRoute(new URL(request.url, config.appOrigin).pathname) });
  return json(response, status, body);
}

async function handleBusiness(request, response, url, user) {
  if (url.pathname.startsWith('/api/workflow')) {
    const record = url.pathname.match(/^\/api\/workflow\/([0-9a-f-]{36})$/i);
    if (record && request.method === 'GET') return businessJson(request, response, user, 200, await workflow.get(record[1]));
    return json(response, 404, { error: '統合ワークフローAPIが見つかりません。' });
  }
  if (url.pathname.startsWith('/api/extraction')) {
    if (request.method === 'GET' && url.pathname === '/api/extraction/config')
      return businessJson(request, response, user, 200, { schema_version: SCHEMA_VERSION, field_labels: FIELD_LABELS,
        max_text_length: MAX_TEXT_LENGTH, output_schema: OUTPUT_SCHEMA, samples: SAMPLES,
        gemini_configured: config.ai.provider === 'gemini' && Boolean(config.ai.apiKey),
        model: config.ai.model, external_policy: 'anonymous_preview_and_per_request_consent',
        business_version: BUSINESS_VERSION, review_topics: TOPICS, review_states: REVIEW_STATES });
    if (request.method === 'POST' && url.pathname === '/api/extraction') {
      const result = await extraction.extract(await readJson(request));
      return businessJson(request, response, user, result.output.status === 'error' ? 422 : 200, result);
    }
    const review = url.pathname.match(/^\/api\/extraction\/([0-9a-f-]{36})\/review$/i);
    if (review && request.method === 'POST') return businessJson(request, response, user, 200, await extraction.review(review[1], await readJson(request)));
    const searchStart = url.pathname.match(/^\/api\/extraction\/([0-9a-f-]{36})\/similar-search$/i);
    if (searchStart && request.method === 'POST') return businessJson(request, response, user, 200, await similarSearch.start(searchStart[1], await readJson(request)));
    const searchLatest = url.pathname.match(/^\/api\/extraction\/([0-9a-f-]{36})\/similar-search\/latest$/i);
    if (searchLatest && request.method === 'GET') return businessJson(request, response, user, 200, { result: await similarSearch.latest(searchLatest[1]) });
    const approvalStart = url.pathname.match(/^\/api\/extraction\/([0-9a-f-]{36})\/approval-email$/i);
    if (approvalStart && request.method === 'POST') return businessJson(request, response, user, 200, await approvalEmail.evaluate(approvalStart[1], await readJson(request)));
    const approvalLatest = url.pathname.match(/^\/api\/extraction\/([0-9a-f-]{36})\/approval-email\/latest$/i);
    if (approvalLatest && request.method === 'GET') return businessJson(request, response, user, 200, { result: await approvalEmail.latest(approvalLatest[1]) });
    const record = url.pathname.match(/^\/api\/extraction\/([0-9a-f-]{36})$/i);
    if (record && request.method === 'GET') return businessJson(request, response, user, 200, await extraction.get(record[1]));
    return json(response, 404, { error: '抽出APIが見つかりません。' });
  }
  if (url.pathname.startsWith('/api/similar-search')) {
    const processTypes = url.pathname.match(/^\/api\/similar-search\/([0-9a-f-]{36})\/process-types$/i);
    if (processTypes && request.method === 'POST') return businessJson(request, response, user, 200, await similarSearch.processTypes(processTypes[1], await readJson(request)));
    const quoteSearch = url.pathname.match(/^\/api\/similar-search\/([0-9a-f-]{36})\/quotes$/i);
    if (quoteSearch && request.method === 'POST') return businessJson(request, response, user, 200, await similarSearch.quotes(quoteSearch[1], await readJson(request)));
    const decision = url.pathname.match(/^\/api\/similar-search\/([0-9a-f-]{36})\/decision$/i);
    if (decision && request.method === 'POST') return businessJson(request, response, user, 200, await similarSearch.decide(decision[1], await readJson(request)));
    const searchRecord = url.pathname.match(/^\/api\/similar-search\/([0-9a-f-]{36})$/i);
    if (searchRecord && request.method === 'GET') return businessJson(request, response, user, 200, await similarSearch.get(searchRecord[1]));
    if (request.method === 'GET' && url.pathname === '/api/similar-search/config')
      return businessJson(request, response, user, 200, { schema_version: SEARCH_SCHEMA_VERSION, rule_version: SEARCH_RULE_VERSION,
        test_queries: SEARCH_TEST_QUERIES, max_entity_candidates: 3, max_quote_candidates: 5,
        approach: 'local_normalization_similarity_weighted_rules', external_ai_calls: 0 });
    return json(response, 404, { error: '類似検索APIが見つかりません。' });
  }
  if (url.pathname.startsWith('/api/approval-email')) {
    if (request.method === 'GET' && url.pathname === '/api/approval-email/config') return businessJson(request, response, user, 200, approvalEmail.config());
    const draftPreview = url.pathname.match(/^\/api\/approval-email\/([0-9a-f-]{36})\/draft-preview$/i);
    if (draftPreview && request.method === 'POST') return businessJson(request, response, user, 200, await approvalEmail.preview(draftPreview[1], await readJson(request)));
    const draftReview = url.pathname.match(/^\/api\/approval-email\/([0-9a-f-]{36})\/drafts\/([0-9a-f-]{36})\/review$/i);
    if (draftReview && request.method === 'POST') return businessJson(request, response, user, 200, await approvalEmail.review(draftReview[1], draftReview[2], await readJson(request)));
    const draftCreate = url.pathname.match(/^\/api\/approval-email\/([0-9a-f-]{36})\/drafts$/i);
    if (draftCreate && request.method === 'POST') return businessJson(request, response, user, 200, await approvalEmail.draft(draftCreate[1], await readJson(request)));
    const approvalRecord = url.pathname.match(/^\/api\/approval-email\/([0-9a-f-]{36})$/i);
    if (approvalRecord && request.method === 'GET') return businessJson(request, response, user, 200, await approvalEmail.get(approvalRecord[1]));
    return json(response, 404, { error: '承認判定・文面下書きAPIが見つかりません。' });
  }
  if (request.method === 'GET' && url.pathname === '/api/counts') return businessJson(request, response, user, 200, { counts: await getCounts() });
  if (request.method === 'GET' && url.pathname === '/api/search') {
    const type = url.searchParams.get('type') || 'customer';
    const q = (url.searchParams.get('q') || '').trim();
    if (!allowedTypes.has(type)) return json(response, 400, { error: 'Unsupported type' });
    if (!q) return json(response, 400, { error: '検索語を入力してください。' });
    return businessJson(request, response, user, 200, { type, q, results: await searchEntities(type, q) });
  }
  if (request.method === 'POST' && url.pathname === '/api/db/write-check') return businessJson(request, response, user, 200, { result: await writeCheck() });
  if (request.method === 'POST' && url.pathname === '/api/ai/test') {
    const body = await readJson(request);
    if (body?.consent !== true) throw new ExtractionError('SEND_CONSENT_REQUIRED', '固定文の送信前プレビューを確認し、今回の送信に同意してください。', 403);
    const result = await testAi();
    return businessJson(request, response, user, result.error ? (result.http_status >= 400 ? result.http_status : 502) : 200, result);
  }
  return false;
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    validateRequestBoundary(request, config);
    url = new URL(request.url, config.appOrigin);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      try { await pool.query('SELECT 1'); return json(response, 200, { ok: true, status: 'healthy' }); }
      catch { return json(response, 503, { ok: false, status: 'unavailable' }); }
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJson(request);
      if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') return json(response, 400, { error: 'ログイン情報を確認してください。' });
      const result = await auth.login(request, body.username, body.password);
      if (!result.ok) return json(response, result.status, { error: 'ユーザー名またはパスワードを確認してください。' });
      return json(response, 200, { ok: true, user: result.user }, { 'set-cookie': result.cookie });
    }

    // Login assets and the shared stylesheet must be served before session routing.
    // Otherwise an authenticated browser receives 404 for /styles.css and the
    // application falls back to an unstyled black-and-white document.
    if (request.method === 'GET' && publicFiles.has(url.pathname.slice(1))) return file(response, url.pathname.slice(1));

    const user = await auth.getSession(request);
    if (!user) {
      if (request.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login.html')) return file(response, 'login.html');
      if (url.pathname.startsWith('/api/')) return json(response, 401, { error: 'ログインしてください。' }, { 'set-cookie': auth.clearCookie() });
      return redirect(response, '/login');
    }

    return await runAsUser(user, async () => {
      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const cookie = await auth.logout(request, user);
        return json(response, 200, { ok: true }, { 'set-cookie': cookie });
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/session') return json(response, 200, { authenticated: true, user });
      if (request.method === 'GET' && url.pathname === '/api/demo/info') {
        const last = await pool.query(`SELECT occurred_at FROM app_audit_events WHERE actor_username=$1 AND event_type='business_operation_completed' ORDER BY occurred_at DESC LIMIT 1`, [user.username]);
        return json(response, 200, { demo: true, user, data_as_of: config.demo.dataAsOf,
          last_operation_at: last.rows[0]?.occurred_at || null, email_auto_send: false });
      }
      if (request.method === 'POST' && url.pathname === '/api/demo/reset') {
        const body = await readJson(request);
        if (!config.demo.dataOnly || body?.confirmation !== 'RESET_DEMO_DATA') throw new ExtractionError('DEMO_RESET_NOT_ALLOWED', 'デモ環境の確認条件が一致しないためリセットしません。', 403);
        await seedDemoData(pool, { actor: user, resetOperations: true });
        return json(response, 200, { ok: true, counts: await demoCounts(pool),
          scope: 'CSV由来データを再投入し、抽出・名寄せ・承認・下書き・書込確認を初期化しました。監査ログ・認証セッション・CSV原本は保持しています。' });
      }
      const handled = await handleBusiness(request, response, url, user);
      if (handled !== false) return handled;
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return file(response, 'index.html');
      if (request.method === 'GET' && protectedFiles.has(url.pathname.slice(1))) return file(response, url.pathname.slice(1));
      if (request.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login.html')) return redirect(response, '/');
      return json(response, 404, { error: 'Not found' });
    });
  } catch (error) {
    if (error instanceof ExtractionError) return json(response, error.status, { code: error.code, error: error.message });
    console.error(`request failed: ${request.method} ${safeRoute(url?.pathname || '/')} (${error?.code || error?.name || 'Error'})`);
    return json(response, 500, { error: '処理に失敗しました。時間をおいて再度お試しください。' });
  }
});

server.listen(config.port, config.bindHost, () => {
  console.log(`application ready: ${config.bindHost}:${config.port}`);
});

async function shutdown() {
  server.close();
  await pool.end();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
