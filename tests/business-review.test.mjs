import test from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_VERSION, emptyBusiness, prepareBusiness } from '../src/business-review.mjs';
import { createExtractionService } from '../src/extraction-service.mjs';
import { normalizeResult, extractLocally } from '../src/extraction.mjs';
import { SAMPLES } from '../src/extraction-samples.mjs';
import { SCHEMA_VERSION } from '../src/extraction-schema.mjs';

const now = new Date('2026-09-01T00:00:00Z');
function record(sample = 'ambiguous') {
  const input = { ...SAMPLES.find(s => s.id === sample), mode: 'local' };
  return { input_payload: input, output_payload: normalizeResult(input, extractLocally(input.request_text)), revision: 1 };
}
function body(r) { const b = r.business_review || emptyBusiness(r.output_payload); return { version: BUSINESS_VERSION, recorder: '架空の営業役', new_answer: null, resolutions: structuredClone(b.resolutions), delivery: structuredClone(b.delivery) }; }
function answer() { return { respondent: '架空の技術担当', responded_at: '2026-08-31T09:00:00+09:00', reference: '架空資料SIM-001第2版', text: '材質SUS304。希望期間2026-09-02〜2026-09-04。' }; }
function resolved() { return { status: 'resolved', reason: '回答原文と一致を確認した（架空試験）。', evidence_ids: ['__new__'] }; }
function prepare(r, b, values = {}) {
  const output = structuredClone(r.output_payload), changes = [];
  for (const [key, value] of Object.entries(values)) { changes.push({ field_name: key, before: output.extracted_fields[key].value, after: value }); output.extracted_fields[key].value = value; }
  return { output, ...prepareBusiness(r, output, changes, b, now) };
}
test('初期状態を既存の単一日・未確認から導出する', () => {
  assert.equal(emptyBusiness(record('clear').output_payload).delivery.kind, 'date');
  assert.equal(emptyBusiness(record().output_payload).delivery.kind, 'unknown');
});
test('回答・根拠・解消状態を別領域に保持し、元の出力を変更しない', () => {
  const r = record(), original = structuredClone(r), b = body(r); b.new_answer = answer(); b.resolutions.material = resolved();
  const out = prepare(r, b, { material: 'SUS304' });
  assert.equal(out.business.answers.length, 1);
  assert.equal(out.business.answers[0].recorded_at, now.toISOString());
  assert.equal(out.business.resolutions.material.evidence_ids[0], out.business.answers[0].id);
  assert.equal(out.output.status, 'needs_review'); assert.equal(out.output.extracted_fields.material.human_status, 'pending');
  assert.deepEqual(r, original);
});
test('希望期間を単一日へ変換せず、期間の根拠を記録する', () => {
  const r = record(), b = body(r); b.new_answer = answer(); b.delivery = { kind: 'window', start: '2026-09-02', end: '2026-09-04' }; b.resolutions.requested_delivery_date = resolved();
  const out = prepare(r, b);
  assert.equal(out.output.extracted_fields.requested_delivery_date.value, null);
  assert.equal(out.business.resolutions.requested_delivery_date.status, 'resolved');
});
for (const bad of [
  { kind: 'window', start: '2026-09-04', end: '2026-09-02' },
  { kind: 'window', start: '2026-02-30', end: '2026-03-05' },
  { kind: 'window', start: '', end: '2026-09-04' },
  { kind: 'window', start: '2020-01-01', end: '2026-09-04' },
  { kind: 'date', start: null, end: null },
  { kind: 'unknown', start: '2026-09-01', end: null }
]) test(`不正な納期形式を拒否: ${JSON.stringify(bad)}`, () => {
  const r = record(), b = body(r); b.delivery = bad; assert.throws(() => prepare(r, b));
});
test('期間と単一日を同時に保存しない', () => {
  const r = record('clear'), b = body(r); b.delivery = { kind: 'window', start: '2026-09-02', end: '2026-09-04' }; assert.throws(() => prepare(r, b));
});
test('同日の期間も保持できる', () => {
  const r = record(), b = body(r); b.delivery = { kind: 'window', start: '2026-09-02', end: '2026-09-02' }; assert.doesNotThrow(() => prepare(r, b));
});
for (const mutate of [
  b => { b.resolutions.material = resolved(); },
  b => { b.new_answer = answer(); b.resolutions.material = { ...resolved(), reason: '' }; },
  b => { b.new_answer = answer(); b.resolutions.material = { ...resolved(), evidence_ids: ['unknown-id'] }; },
  b => { b.new_answer = answer(); b.resolutions.material = { ...resolved(), evidence_ids: ['__new__', '__new__'] }; },
  b => { b.new_answer = answer(); b.resolutions.material = { ...resolved(), status: 'approved' }; },
  b => { b.answers = []; },
  b => { b.resolutions.material.extra = 'injected'; },
  b => { b.recorder = ''; },
  b => { b.version = 'unknown'; }
]) test('理由・根拠・形式の不足や認証状態の注入を拒否', () => {
  const r = record(), b = body(r); mutate(b); assert.throws(() => prepare(r, b, { material: 'SUS304' }));
});
test('値が空欄の項目を解消済みにできない', () => {
  const r = record(), b = body(r); b.new_answer = answer(); b.resolutions.material = resolved(); assert.throws(() => prepare(r, b), /空欄/);
});
test('今回不要には根拠を必要とし、不要として入力値を隠さない', () => {
  const r = record(), b = body(r); b.new_answer = answer(); b.resolutions.tolerance = { ...resolved(), status: 'not_required' };
  assert.doesNotThrow(() => prepare(r, b));
  assert.throws(() => prepare(r, b, { tolerance: '±0.2 mm' }), /値があります/);
  b.resolutions.quantity = { ...resolved(), status: 'not_required' }; assert.throws(() => prepare(r, b));
});
test('回答待ちには確認先・確認事項が必要', () => {
  const r = record(), b = body(r); b.resolutions.tolerance.status = 'awaiting_reply'; assert.throws(() => prepare(r, b));
  b.resolutions.tolerance.reason = '顧客へ今回適用する図面を確認'; assert.doesNotThrow(() => prepare(r, b));
});
for (const timestamp of ['2026-09-02T00:00:00Z', '2026-08-31T24:00:00+09:00', '2026-08-31T10:00', '2026-02-30T09:00:00+09:00', '2020-01-01T10:00:00Z']) test(`不正な回答日時を拒否: ${timestamp}`, () => {
  const r = record(), b = body(r); b.new_answer = { ...answer(), responded_at: timestamp }; assert.throws(() => prepare(r, b));
});
test('値変更時は同じ根拠の解消済みを自動的に未確認へ戻す', () => {
  const r = record(), b = body(r); b.new_answer = answer(); b.resolutions.material = resolved(); b.resolutions.product_identity = resolved();
  const first = prepare(r, b, { material: 'SUS304' }); r.business_review = first.business; r.output_payload = first.output;
  const again = prepare(r, body(r), { material: 'SUS316' });
  assert.deepEqual(again.reopened.sort(), ['material', 'product_identity']);
  assert.equal(again.business.resolutions.material.status, 'unresolved');
  // A new answer can explicitly support a new decision without rewriting old evidence.
  const changed = body(r); changed.new_answer = { ...answer(), text: '訂正：SUS316です。' }; changed.resolutions.material = resolved();
  const supported = prepare(r, changed, { material: 'SUS316' });
  assert.equal(supported.business.answers.length, 2); assert.equal(supported.business.resolutions.material.status, 'resolved');
  assert.deepEqual(supported.business.answers[0], first.business.answers[0]);
});
test('期間変更時と旧クライアントの値変更時も再確認へ戻す', () => {
  const r = record(), b = body(r); b.new_answer = answer(); b.delivery = { kind: 'window', start: '2026-09-02', end: '2026-09-04' }; b.resolutions.requested_delivery_date = resolved();
  const first = prepare(r, b); r.business_review = first.business; r.output_payload = first.output;
  const changed = body(r); changed.delivery.end = '2026-09-05';
  assert.equal(prepare(r, changed).business.resolutions.requested_delivery_date.status, 'unresolved');
  assert.equal(prepare(r, undefined, { requested_delivery_date: '2026-09-03' }).business.resolutions.requested_delivery_date.status, 'unresolved');
});

function memoryStore() {
  const rows = new Map(); return { rows,
    async start(id, input, output, execution) { rows.set(id, { input_payload: structuredClone(input), output_payload: structuredClone(output), execution: structuredClone(execution), revision: 0 }); },
    async finish(id, output, execution) { Object.assign(rows.get(id), { output_payload: structuredClone(output), initial_output: structuredClone(output), execution: structuredClone(execution), revision: 1 }); },
    async get(id) { return structuredClone(rows.get(id)); },
    async saveReview(id, rev, output, changes, business) { const r = rows.get(id); if (rev !== r.revision) return null; Object.assign(r, { output_payload: structuredClone(output), business_review: structuredClone(business) }); return ++r.revision; }
  };
}
test('サービス経由で根拠・解消状態を再読出し、初回を保持、古い版を拒否', async () => {
  const store = memoryStore(); const s = createExtractionService({ store, ai: {}, fetchFn: () => assert.fail('外部AI禁止') });
  const { id, label, source, ...sample } = SAMPLES[2];
  const first = await s.extract({ ...sample, schema_version: SCHEMA_VERSION, mode: 'local', consent: false });
  const key = first.output.audit_log_id, r = await store.get(key), b = body(r); b.new_answer = answer(); b.resolutions.material = resolved();
  const values = Object.fromEntries(Object.entries(first.output.extracted_fields).map(([k, f]) => [k, f.value])); values.material = 'SUS304';
  const req = { revision: 1, values, acknowledged: true, business_review: b };
  const saved = await s.review(key, req), read = await s.get(key);
  assert.deepEqual(saved.business_review, read.business_review); assert.deepEqual(read.initial_output, first.output);
  await assert.rejects(s.review(key, req), /更新されました/);
  assert.equal(read.output.status, 'needs_review'); assert.equal(read.execution.external_attempts, 0);
});
test('全体保留の依頼は新しい確認記録でも解除できない', async () => {
  const store = memoryStore(); const s = createExtractionService({ store, ai: {}, fetchFn: () => assert.fail('外部AI禁止') });
  const { id, label, source, ...sample } = SAMPLES[3]; const first = await s.extract({ ...sample, schema_version: SCHEMA_VERSION, mode: 'local', consent: false });
  const r = await store.get(first.output.audit_log_id);
  await assert.rejects(s.review(first.output.audit_log_id, { revision: 1, acknowledged: true, values: {}, business_review: body(r) }), /解除できません/);
});
