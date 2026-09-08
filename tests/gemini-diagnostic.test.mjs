import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseGemini, diagnosticPrompt } from '../src/gemini-diagnostic.mjs';

const key = 'dummy-test-key-not-a-real-credential';
const model = 'gemini-3.7-flash';
const reply = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test('固定文だけを1回送信し、リダイレクトを禁止する', async () => {
  let calls = 0;
  const result = await diagnoseGemini({ apiKey: key, model, fetchFn: async (url, options) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent');
    assert.equal(options.headers['x-goog-api-key'], key);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(JSON.parse(options.body).contents[0].parts[0].text, diagnosticPrompt);
    return reply(200, { candidates: [{ content: { parts: [{ thought: true, text: 'internal' }, { text: 'OK' }] } }] });
  }});
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.verified_external_connection, true);
  assert.equal(result.response, 'OK');
  assert.ok(!JSON.stringify(result).includes(key));
});

test('診断ログは段階と時刻だけを記録し、秘密・入力文・応答本文を含めない', async () => {
  const stages = [];
  const result = await diagnoseGemini({
    apiKey: key,
    model,
    onStage: entry => stages.push(entry),
    fetchFn: async () => reply(200, { candidates: [{ content: { parts: [{ text: 'OK' }] } }] })
  });

  assert.equal(result.verified_external_connection, true);
  assert.deepEqual(stages.map(entry => entry.stage), [
    'request_started',
    'response_headers_received',
    'response_body_read',
    'completed'
  ]);
  assert.equal(new Set(stages.map(entry => entry.diagnostic_id)).size, 1);
  for (const entry of stages) {
    assert.deepEqual(Object.keys(entry).sort(), ['diagnostic_id', 'elapsed_ms', 'event', 'stage', 'timestamp']);
    assert.equal(entry.event, 'gemini_diagnostic');
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Number.isInteger(entry.elapsed_ms), true);
  }
  const logText = JSON.stringify(stages);
  for (const forbidden of [key, diagnosticPrompt, 'OK', model]) assert.ok(!logText.includes(forbidden));
});

for (const status of [400, 403, 429, 503]) {
  test(`HTTP ${status}でも再試行せず元の詳細を保持する`, async () => {
    let calls = 0;
    const result = await diagnoseGemini({ apiKey: key, model, fetchFn: async () => {
      calls++;
      return reply(status, { error: { status: 'PROVIDER_STATUS', message: 'Original provider explanation.' } });
    }});
    assert.equal(calls, 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.http_status, status);
    assert.equal(result.provider_status, 'PROVIDER_STATUS');
    assert.equal(result.provider_message, 'Original provider explanation.');
    assert.equal(result.verified_external_connection, false);
  });
}

test('エラー本文・状態・理由から秘密値を削除し、その他の応答を破棄する', async () => {
  const result = await diagnoseGemini({ apiKey: key, model, fetchFn: async () => reply(503, {
    error: {
      status: key,
      message: `Secret ${key}; https://example.invalid/?key=${key} Bearer abcsecret API_KEY=othersecret`,
      details: [{ reason: key, metadata: { private: key } }]
    }, secret: key
  }) });
  const output = JSON.stringify(result);
  for (const secret of [key, 'abcsecret', 'othersecret', 'example.invalid', 'metadata']) assert.ok(!output.includes(secret));
  assert.match(result.provider_message, /REDACTED/);
});

test('キー未設定ならfetchを呼ばない', async () => {
  const result = await diagnoseGemini({ apiKey: '', model, fetchFn: () => assert.fail('must not call') });
  assert.equal(result.attempts, 0);
  assert.equal(result.verified_external_connection, false);
});

test('回答テキストがないHTTP 200は生成成功とみなさない', async () => {
  const result = await diagnoseGemini({ apiKey: key, model, fetchFn: async () => reply(200, {
    candidates: [{ finishReason: 'MAX_TOKENS' }]
  }) });
  assert.equal(result.http_status, 200);
  assert.equal(result.verified_external_connection, false);
  assert.equal(result.finish_reason, 'MAX_TOKENS');
});

test('タイムアウトで1回で終了し秘密を含む例外を出さない', async () => {
  let calls = 0;
  const stages = [];
  const result = await diagnoseGemini({ apiKey: key, model, timeoutMs: 5, onStage: entry => stages.push(entry), fetchFn: async (_url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(reply(200, {})), 100);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }});
  assert.equal(calls, 1);
  assert.equal(result.failure_kind, 'timeout');
  assert.equal(result.http_status, null);
  assert.deepEqual(stages.map(entry => entry.stage), ['request_started', 'timed_out']);
  assert.ok(!JSON.stringify(stages).includes(key));
});

test('不正JSONとネットワーク例外の原文を返さない', async () => {
  for (const error of [new SyntaxError(key), new TypeError(key)]) {
    const result = await diagnoseGemini({ apiKey: key, model, fetchFn: async () => { throw error; } });
    assert.ok(!JSON.stringify(result).includes(key));
    assert.equal(result.verified_external_connection, false);
  }
});
