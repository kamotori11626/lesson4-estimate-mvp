// Local test API + isolated PostgreSQL only. No extraction/AI request is made.
import assert from 'node:assert/strict';
import pg from 'pg';
import { config } from '../src/config.mjs';

const [schema, runId] = process.argv.slice(2);
assert.match(schema, /^fallback_ui_[a-z0-9_]+$/);
assert.ok(schema.length <= 63);
assert.match(runId, /^[0-9a-f-]{36}$/);
const pool = new pg.Pool(config.pg);
const base = `http://127.0.0.1:4174/api/extraction/${runId}`;
const get = async () => { const response = await fetch(base); assert.equal(response.status, 200); return response.json(); };
try {
  const initial = await get();
  assert.equal(initial.execution.test_context.schema, schema);
  assert.equal(initial.execution.mode, 'test_simulation');
  assert.equal(initial.revision, 2); // Browser already saved quantity 1 -> 2.
  assert.equal(initial.output.extracted_fields.quantity.value, 2);
  const body = { revision: initial.revision, acknowledged: true,
    values: Object.fromEntries(Object.entries(initial.output.extracted_fields).map(([key, field]) => [key, field.value])) };
  const response = await fetch(`${base}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  const unchanged = await response.json();
  assert.equal(unchanged.revision, 3);
  assert.deepEqual(unchanged.output, initial.output);
  const stale = await fetch(`${base}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(stale.status, 409);
  const reloaded = await get();
  assert.equal(reloaded.revision, 3);
  assert.deepEqual(reloaded.output, unchanged.output);
  assert.deepEqual(reloaded.execution, initial.execution);
  const record = (await pool.query(`SELECT * FROM ${schema}.extraction_runs WHERE run_id=$1`, [runId])).rows[0];
  assert.deepEqual(record.output_payload, reloaded.output);
  assert.deepEqual(record.execution, reloaded.execution);
  const histories = (await pool.query(`SELECT changes,jsonb_typeof(changes) AS type FROM ${schema}.extraction_review_drafts WHERE run_id=$1 ORDER BY id`, [runId])).rows;
  assert.deepEqual(histories, [
    { changes: [{ field_name: 'quantity', before: 1, after: 2 }], type: 'array' },
    { changes: [], type: 'array' }
  ]);
  const events = (await pool.query(`SELECT event_type,event_summary FROM ${schema}.extraction_events WHERE run_id=$1 ORDER BY id`, [runId])).rows;
  assert.deepEqual(events.map(e => e.event_type), ['started', 'finished', 'review_draft_saved', 'review_draft_saved']);
  assert.deepEqual(events[2].event_summary.changed_fields, ['quantity']);
  assert.deepEqual(events[3].event_summary.changed_fields, []);
  assert.equal(reloaded.execution.extraction_method, 'local_labelled_fallback');
  assert.equal(reloaded.execution.scope_decision.model_scope, 'uncertain');
  assert.equal(reloaded.output.status, 'needs_review');
  for (const field of Object.values(reloaded.output.extracted_fields)) assert.equal(field.human_status, 'pending');
  assert.equal(reloaded.output.extracted_fields.quantity.source_quote, '1枚');
  for (const field of ['dimensions', 'tolerance', 'requested_delivery_date']) assert.equal(reloaded.output.extracted_fields[field].value, null);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM public.extraction_runs WHERE run_id=$1', [runId])).rows[0].count), 0);
  const testStatus = await (await fetch('http://127.0.0.1:4174/api/test/status')).json();
  assert.equal(testStatus.simulated_calls, 1);
  assert.equal(testStatus.actual_external_requests, 0);
  assert.equal(testStatus.blocked_network_calls, 0);
  console.log(JSON.stringify({ result: 'PASS', schema, run_id: runId,
    browser_observed: { original_quantity: 1, saved_quantity: 2, revision: 2,
      saved_message: '修正下書きを保存しました。正式な確認済み・後工程への引渡しではありません。',
      final_browser_reload_verified: false, reason: 'Chrome connection timed out before readback; API readback separately verified below' },
    api_reloaded: reloaded, database_record: record, histories, events, stale_http_status: stale.status, test_status: testStatus }));
} finally { await pool.end(); }
