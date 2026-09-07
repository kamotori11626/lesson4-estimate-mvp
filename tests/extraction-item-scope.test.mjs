import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAMPLES } from '../src/extraction-samples.mjs';
import { assessSingleItem } from '../src/extraction-scope.mjs';
import { blankModel, matchesSchema, OUTPUT_SCHEMA, SCHEMA_VERSION } from '../src/extraction-schema.mjs';
import { normalizeResult, scopeWarning } from '../src/extraction.mjs';
import { createExtractionService } from '../src/extraction-service.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/extraction-step3.expected.json', import.meta.url), 'utf8')).cases;
const ai = { provider: 'gemini', model: 'test-only', apiKey: 'dummy-key' };
const noFetch = () => assert.fail('No external calls allowed');
const values = output => Object.fromEntries(Object.entries(output.extracted_fields).map(([key, f]) => [key, f.value]));
const has = (output, code) => output.warnings_and_holds.some(w => w.code === code);
function input(id = 'ambiguous', changes = {}) {
  const { id: _, label, source, ...sample } = SAMPLES.find(s => s.id === id);
  return { ...sample, schema_version: SCHEMA_VERSION, mode: 'local', consent: false, ...changes };
}
function memoryStore() {
  const rows = new Map();
  return {
    async start(id, data, output, execution) { rows.set(id, structuredClone({ input_payload: data, output_payload: output, execution, revision: 0 })); },
    async finish(id, output, execution) { Object.assign(rows.get(id), structuredClone({ output_payload: output, execution, revision: 1 })); },
    async get(id) { return structuredClone(rows.get(id)); },
    async saveReview(id, revision, output) { const row = rows.get(id); if (row.revision !== revision) return null; row.output_payload = structuredClone(output); return ++row.revision; }
  };
}
const reply = model => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(model) }] } }] }) });

for (const id of ['clear', 'missing', 'ambiguous']) test(`仕様不足とは別に本文全体の単一商品根拠を確認する：${id}`, () => {
  const data = input(id), assessment = assessSingleItem(data);
  assert.equal(assessment.classification, 'single_labelled');
  assert.equal(scopeWarning(data), null);
  for (const e of assessment.evidence) assert.equal(data.request_text.slice(e.source_location.start, e.source_location.end), e.source_quote);
});

test('1.2実測の全体保留パターン：AI uncertainを残し、原文だけで部分下書きを復元する', async () => {
  const old = JSON.parse(readFileSync(new URL('../docs/extraction-step3-retest-v12-results-2026-08-31.json', import.meta.url), 'utf8')).find(c => c.id === 'ambiguous');
  assert.ok(has(old.result.output, 'SCOPE_UNCERTAIN'));
  assert.equal(old.result.execution.rule_version, 'extraction-rules-1.2');
  // Saved application output identifies this path. Raw provider response was not retained.
  // Reconstruct the observed scope/empty-field pattern, not the exact provider payload.
  const model = blankModel('uncertain'), original = structuredClone(model);
  let calls = 0;
  const store = memoryStore();
  const service = createExtractionService({ store, ai, fetchFn: async () => { calls++; return reply(model); } });
  const result = await service.extract(input('ambiguous', { mode: 'gemini', consent: true }));
  const output = result.output, expected = fixture.find(c => c.id === 'ambiguous');
  assert.equal(calls, 1); // Mock only, never a second AI call or hidden retry.
  assert.deepEqual(model, original);
  assert.deepEqual(values(output), expected.expected_values);
  assert.deepEqual(output.missing_fields.map(f => f.field_name).sort(), [...expected.expected_missing].sort());
  assert.deepEqual(output.warnings_and_holds.filter(w => w.code === 'AMBIGUOUS').map(w => w.source).sort(), [...expected.expected_ambiguity].sort());
  assert.ok(has(output, 'LOCAL_SCOPE_FALLBACK'));
  assert.ok(!has(output, 'SCOPE_UNCERTAIN'));
  assert.equal(result.execution.scope_decision.model_scope, 'uncertain');
  assert.equal(result.execution.scope_decision.outcome, 'local_labelled_fallback');
  assert.equal(result.execution.extraction_method, 'local_labelled_fallback');
  assert.equal(result.execution.verified_external_response, true);
  assert.equal(result.execution.verified_external_extraction, false);
  assert.equal(result.execution.external_attempts, 1);
  for (const f of Object.values(output.extracted_fields)) {
    assert.equal(f.human_status, 'pending'); assert.equal(f.confidence, null);
    if (f.source_quote !== null) assert.equal(input()[f.source_location.source_id].slice(f.source_location.start, f.source_location.end), f.source_quote);
  }
  assert.equal(output.extracted_fields.dimensions.source_quote, '寸法と公差は前回同様です');
  assert.equal(output.extracted_fields.tolerance.source_quote, '寸法と公差は前回同様です');
  assert.ok(matchesSchema(output, OUTPUT_SCHEMA));
  assert.deepEqual((await service.get(output.audit_log_id)).execution, result.execution);
  const reviewed = await service.review(output.audit_log_id, { revision: 1, acknowledged: true, values: values(output) });
  assert.equal(reviewed.output.status, 'needs_review');
  assert.ok(has(reviewed.output, 'LOCAL_SCOPE_FALLBACK'));
  assert.deepEqual(reviewed.execution.scope_decision, result.execution.scope_decision);
});

test('AIの不明応答に候補が混じっても使わない：ローカル下書きの由来を偽らない', () => {
  const model = blankModel('uncertain');
  model.fields.material = { value: 'SUS316', source_quote: '捏造', confidence: 1, ambiguous: false, candidate: null };
  model.fields.quantity = { value: 5000, source_quote: '捏造', confidence: 1, ambiguous: false, candidate: null };
  const output = normalizeResult(input(), model);
  assert.equal(output.extracted_fields.material.value, null);
  assert.equal(output.extracted_fields.quantity.value, 1);
  assert.equal(output.extracted_fields.quantity.confidence, null);
});

for (const text of [
  'お見積りをお願いします。\n品番: XX-901\n数量: 20個\n寸法: 未定\n公差: 前回同様\n希望納期: 来月上旬',
  '品名: 樹脂カバー\n数量: 不明\n材質: 不明\n寸法と公差は前回同様です。',
  '品名: 樹脂カバー\n数量: 0個\n希望納期: 2026-02-30',
  '品名: 樹脂カバー\n品番: 0003-Z\n数量: 500\n公差: +0.02/-0.01 mm'
]) test(`固定例に依存しない単一商品書式：${text}`, () => {
  const data = input('clear', { request_text: text });
  assert.equal(assessSingleItem(data).classification, 'single_labelled');
  const out = normalizeResult(data, blankModel('uncertain'));
  assert.ok(has(out, 'LOCAL_SCOPE_FALLBACK'));
  assert.ok(matchesSchema(out, OUTPUT_SCHEMA));
  assert.equal(out.status, 'needs_review');
  if (text.includes('数量: 0個')) assert.equal(out.extracted_fields.quantity.value, null);
  if (text.includes('2026-02-30')) assert.equal(out.extracted_fields.requested_delivery_date.value, null);
  if (text.includes('500\n')) assert.ok(has(out, 'UNIT_MISSING'));
});

for (const text of [
  '前回注文した一式を見積してください。',
  '品名: 前回の一式\n数量: 1式',
  '品名: 商品A/商品B\n数量: 1個',
  '品名: 商品Aと商品B\n数量: 1個',
  '10商品を見積してください。',
  '品名: 商品A。品名: 商品B。数量: 1個',
  '品番: TEST-01\n数量: 100個\n別の商品もお願いします。'
]) test(`商品数が不明・複数の依頼は両モードで送信前に保留：${text}`, async () => {
  for (const mode of ['local', 'gemini']) {
    const data = input('clear', { request_text: text, mode, consent: true });
    assert.ok(scopeWarning(data));
    const service = createExtractionService({ store: memoryStore(), ai, fetchFn: noFetch });
    const result = await service.extract(data);
    assert.ok(Object.values(result.output.extracted_fields).every(f => f.value === null));
    assert.equal(result.execution.external_attempts, 0);
    assert.equal(result.execution.scope_decision.outcome, 'whole_request_hold');
    await assert.rejects(service.review(result.output.audit_log_id, { revision: 1, values: {}, acknowledged: true }), /解除できません/);
    // Direct normalizer also cannot bypass the preflight via model single.
    assert.ok(Object.values(normalizeResult(data, blankModel('single')).extracted_fields).every(f => f.value === null));
  }
});

for (const suffix of [
  '\n他にも見積をお願いします', '\n追伸：ナットも見積ください', '\n品名: 別商品',
  '\n数量: 2枚', '\n材質: SUS304。ボルトも追加してください',
  '\n仕様: 任意の未対応欄', '\n公差: 前回同様、部品Bも含む', '\n単価: 100円'
]) test(`未知の追記を読み飛ばしてuncertainを解除しない：${suffix}`, () => {
  const data = input('ambiguous', { request_text: input().request_text + suffix });
  assert.notEqual(assessSingleItem(data).classification, 'single_labelled');
  const output = normalizeResult(data, blankModel('uncertain'));
  assert.ok(!has(output, 'LOCAL_SCOPE_FALLBACK'));
  assert.ok(Object.values(output.extracted_fields).every(f => f.value === null));
});

for (const name of ['bolt and nut', 'A B', 'A・B', 'A + B']) test(`商品列挙と区別できない識別子は単一商品根拠にしない：${name}`, () => {
  const data = input('clear', { request_text: `品名: ${name}\n数量: 1個` });
  assert.notEqual(assessSingleItem(data).classification, 'single_labelled');
  assert.ok(!has(normalizeResult(data, blankModel('uncertain')), 'LOCAL_SCOPE_FALLBACK'));
});

for (const change of [{ item_scope: 'unknown' }, { item_scope: 'multiple' }, { case_type: '新規特注' }, { case_type: '緊急' }]) test(`選択欄の安全条件はローカル根拠より優先する：${JSON.stringify(change)}`, () => {
  const output = normalizeResult(input('ambiguous', change), blankModel('uncertain'));
  assert.ok(!has(output, 'LOCAL_SCOPE_FALLBACK'));
  assert.ok(Object.values(output.extracted_fields).every(f => f.value === null));
});

test('1商品の自己申告・高信頼度のAI候補だけで不明判定を解除しない', () => {
  const data = input('clear', { request_text: 'カバーの見積です。' });
  const model = blankModel('uncertain');
  model.fields.product_name = { value: 'カバー', source_quote: 'カバー', confidence: 1, ambiguous: false, candidate: null };
  assert.ok(has(normalizeResult(data, model), 'SCOPE_UNCERTAIN'));
});

test('過去1.2の不合格結果・期待値を修正して成功にしない', () => {
  const saved = JSON.parse(readFileSync(new URL('../docs/extraction-step3-retest-v12-evaluation-2026-08-31.json', import.meta.url), 'utf8'));
  assert.equal(saved.summary.cases_passed, 2);
  assert.equal(saved.summary.external_attempts, 3);
  assert.equal(saved.cases.find(c => c.id === 'ambiguous').pass, false);
});

test('引用上限を超える識別子はローカル復元へ進めず保留する', () => {
  const data = input('clear', { request_text: `品番: ${'A'.repeat(1200)}\n数量: 1個` });
  assert.notEqual(assessSingleItem(data).classification, 'single_labelled');
  const out = normalizeResult(data, blankModel('uncertain'));
  assert.ok(has(out, 'SCOPE_UNCERTAIN'));
  assert.ok(matchesSchema(out, OUTPUT_SCHEMA));
});
