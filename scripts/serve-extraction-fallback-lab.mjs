// Isolated UI/DB integration lab. Never imported by the normal application or test runner.
// No real API key, no external requests, separate port and PostgreSQL schema.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { config } from '../src/config.mjs';
import { createExtractionService } from '../src/extraction-service.mjs';
import { createExtractionStore } from '../src/extraction-store.mjs';
import { blankModel, FIELD_LABELS, MAX_TEXT_LENGTH, OUTPUT_SCHEMA, SCHEMA_VERSION } from '../src/extraction-schema.mjs';
import { ExtractionError } from '../src/extraction.mjs';
import { SAMPLES } from '../src/extraction-samples.mjs';
import { readJson } from '../src/json-body.mjs';
import { BUSINESS_VERSION, TOPICS, REVIEW_STATES } from '../src/business-review.mjs';

assert.equal(process.argv[2], '--isolated-no-external-ai');
const port = 4174;
const schema = process.argv[3] || 'fallback_ui_v13_20260831';
assert.match(schema, /^fallback_ui_[a-z0-9_]+$/);
assert.ok(schema.length <= 63);
const model = 'TEST_ONLY_SIMULATED_UNCERTAIN';
let blockedNetworkCalls = 0, simulatedCalls = 0;
globalThis.fetch = async () => { blockedNetworkCalls++; throw new Error('OUTBOUND_FETCH_DISABLED'); };
const pool = new pg.Pool({ ...config.pg, options: `-c search_path=${schema},pg_catalog`, max: 3 });
const setup = await pool.connect();
try {
  await setup.query('BEGIN');
  // Deliberately fail if this exact test schema already exists; never reset old evidence.
  await setup.query(`CREATE SCHEMA ${schema}`);
  await setup.query(await fs.readFile(new URL('../db/extraction.sql', import.meta.url), 'utf8'));
  await setup.query('COMMIT');
} catch (error) { await setup.query('ROLLBACK'); throw error; }
finally { setup.release(); }

const store = createExtractionStore(pool);
function markSimulation(execution) {
  const simulatedAttempts = execution.external_attempts;
  execution.mode = 'test_simulation';
  execution.execution_user_id = 'isolated-fallback-ui-test';
  execution.identity_mode = 'unauthenticated_test_only';
  execution.external_attempts = 0;
  execution.verified_external_response = false;
  execution.verified_external_extraction = false;
  execution.test_context = { simulated_response: true, simulated_provider_attempts: simulatedAttempts,
    actual_external_requests: 0, schema, fixture: 'scope_uncertain_all_fields_null' };
}
const testStore = {
  ...store,
  async start(id, input, output, execution) { markSimulation(execution); return store.start(id, input, output, execution); },
  async finish(id, output, execution) { markSimulation(execution); return store.finish(id, output, execution); }
};
const extraction = createExtractionService({ store: testStore,
  ai: { provider: 'gemini', apiKey: 'TEST_DUMMY_NOT_A_KEY', model },
  fetchFn: async (url, options) => {
    assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
    assert.equal(options.headers['x-goog-api-key'], 'TEST_DUMMY_NOT_A_KEY');
    simulatedCalls++;
    // Return in process; the URL is checked but NEVER contacted.
    return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP',
      content: { parts: [{ text: JSON.stringify(blankModel('uncertain')) }] } }] }) };
  }
});

const originals = Object.fromEntries(await Promise.all(['index.html', 'extraction.js', 'styles.css'].map(async name =>
  [name, await fs.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')])));
// Keep extraction controls and the SAME renderer. Only add visible test labelling.
const extractionSectionEnd = originals['index.html'].indexOf('      <section>');
assert.ok(extractionSectionEnd > 0);
const html = (originals['index.html'].slice(0, extractionSectionEnd)
  + '</main><script type="module" src="/extraction.js"></script></body></html>')
  .replace('<title>見積・受注前処理エージェント</title>', '<title>テスト専用：ローカル代替検証</title>')
  .replace('<main>', '<main><p role="note" class="notice">テスト専用：模擬応答・外部送信なし。実Geminiには接続しません。画面内のGemini表示は模擬テスト操作です。保存先は通常記録と分離しています。</p>')
  .replace('Gemini抽出（匿名サンプルのみ）', '模擬AI応答で代替を検証（外部送信なし）')
  .replace('表示された匿名サンプルを今回Geminiへ送信することに同意する（利用料が発生する場合があります）', 'この匿名サンプルで模擬応答テストを実行する（外部送信・API利用料なし）');

const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  try {
    const host = `127.0.0.1:${port}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { error: 'Test origin only' });
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && ['/', '/extraction.js', '/styles.css'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': url.pathname === '/' ? 'text/html; charset=utf-8' : url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'" });
      return res.end(url.pathname === '/' ? html : originals[url.pathname.slice(1)]);
    }
    if (req.method === 'GET' && url.pathname === '/api/extraction/config') return json(res, 200, {
      schema_version: SCHEMA_VERSION, field_labels: FIELD_LABELS, max_text_length: MAX_TEXT_LENGTH,
      output_schema: OUTPUT_SCHEMA, samples: SAMPLES, gemini_configured: true, model,
      external_policy: 'TEST_ONLY_NO_EXTERNAL_NETWORK', test_schema: schema,
      business_version: BUSINESS_VERSION, review_topics: TOPICS, review_states: REVIEW_STATES
    });
    if (req.method === 'GET' && url.pathname === '/api/test/status') return json(res, 200, {
      test_only: true, schema, port, model, simulated_calls: simulatedCalls,
      actual_external_requests: 0, blocked_network_calls: blockedNetworkCalls,
      production_server_modified: false,
      renderer_sha256: createHash('sha256').update(originals['extraction.js']).digest('hex')
    });
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
    if (req.method === 'POST' && url.pathname === '/api/extraction') {
      const result = await extraction.extract(await readJson(req));
      return json(res, result.output.status === 'error' ? 422 : 200, result);
    }
    const review = url.pathname.match(/^\/api\/extraction\/([0-9a-f-]{36})\/review$/i);
    if (req.method === 'POST' && review) return json(res, 200, await extraction.review(review[1], await readJson(req)));
    const record = url.pathname.match(/^\/api\/extraction\/([0-9a-f-]{36})$/i);
    if (req.method === 'GET' && record) return json(res, 200, await extraction.get(record[1]));
    // In particular, there is NO real /api/ai/test endpoint here.
    return json(res, 404, { error: 'Test route not available' });
  } catch (error) {
    return json(res, error instanceof ExtractionError ? error.status : 500, { error: error instanceof ExtractionError ? error.message : 'Test request failed' });
  }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ test_only: true, url: `http://127.0.0.1:${port}`, schema,
  pid: process.pid, actual_external_requests: 0, production_server_modified: false })));
async function shutdown() { await new Promise(resolve => server.close(resolve)); await pool.end(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
