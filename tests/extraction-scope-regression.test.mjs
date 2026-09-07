import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAMPLES } from '../src/extraction-samples.mjs';
import { EXTRACTION_PROMPT } from '../src/extraction-prompt.mjs';
import { blankModel, matchesSchema, MODEL_SCHEMA, OUTPUT_SCHEMA, PROMPT_VERSION, RULE_VERSION, SCHEMA_VERSION } from '../src/extraction-schema.mjs';
import { normalizeResult, scopeWarning } from '../src/extraction.mjs';
import { createExtractionService } from '../src/extraction-service.mjs';

// Controlled provider responses test application behavior, NOT Gemini's accuracy.
const expected = JSON.parse(readFileSync(new URL('./fixtures/extraction-step3.expected.json', import.meta.url), 'utf8'))
  .cases.find(c => c.id === 'ambiguous');
const ai = { provider: 'gemini', apiKey: 'dummy-key-never-real', model: 'configured-test-model' };
function input(id = 'ambiguous', changes = {}) {
  const { id: _, label, source, ...data } = SAMPLES.find(s => s.id === id);
  return { schema_version: SCHEMA_VERSION, ...data, mode: 'gemini', consent: true, ...changes };
}
function partialResponse() {
  const model = blankModel('single');
  for (const [key, value, quote] of [
    ['product_name', 'MCナイロンプレート300', 'MCナイロンプレート300'],
    ['quantity', 1, '1枚'], ['quantity_unit', '枚', '1枚']
  ]) model.fields[key] = { value, source_quote: quote, confidence: 0.9, ambiguous: false, candidate: null };
  for (const [key, quote] of [
    ['requested_delivery_date', '来月半ば'], ['dimensions', '寸法と公差は前回同様です。'], ['tolerance', '寸法と公差は前回同様です。']
  ]) model.fields[key] = { value: null, source_quote: quote, confidence: null, ambiguous: true, candidate: quote };
  return model;
}
function storeInMemory() {
  const rows = new Map();
  return {
    async start(id, data, output, execution) { rows.set(id, structuredClone({ input_payload: data, output_payload: output, execution, revision: 0 })); },
    async finish(id, output, execution) { Object.assign(rows.get(id), structuredClone({ output_payload: output, execution, revision: 1 })); },
    async get(id) { return structuredClone(rows.get(id)); }
  };
}
function response(model) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(model) }] } }] }) };
}
const noFetch = () => assert.fail('External AI calls are forbidden in this regression test');

test('scope境界の指示とスキーマ説明を明記し、プロンプト・ルール版を更新する', () => {
  assert.equal(PROMPT_VERSION, 'extraction-prompt-1.3');
  assert.equal(RULE_VERSION, 'extraction-rules-1.3');
  assert.ok(EXTRACTION_PROMPT.includes('項目の不足・曖昧さだけを理由にscope=uncertainにしない'));
  assert.ok(EXTRACTION_PROMPT.includes('区別する対比例'));
  assert.match(MODEL_SCHEMA.properties.scope.description, /項目/);
  assert.match(MODEL_SCHEMA.properties.fields.properties.dimensions.properties.ambiguous.description, /項目/);
  // Do not put this failed case's expected answer into the instructional examples.
  assert.ok(!EXTRACTION_PROMPT.includes('MCナイロンプレート300'));
});

test('実失敗例はローカルの対象範囲チェックを通過する：項目の曖昧さだけで全体保留にしない', () => {
  assert.equal(scopeWarning(input()), null);
  assert.equal(matchesSchema(partialResponse(), MODEL_SCHEMA), true);
});

test('singleの試験用AI応答なら、事前期待値どおり品名・数量を保持し3項目を個別要確認にする', async () => {
  let calls = 0;
  const service = createExtractionService({ store: storeInMemory(), ai, fetchFn: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.systemInstruction.parts[0].text, EXTRACTION_PROMPT);
    assert.deepEqual(body.generationConfig.responseJsonSchema, MODEL_SCHEMA);
    assert.ok(body.contents[0].parts[0].text.includes('[CUSTOMER]'));
    assert.ok(!options.body.includes('検証用顧客C'));
    return response(partialResponse());
  } });
  const result = await service.extract(input());
  const output = result.output;
  assert.equal(calls, 1);
  assert.equal(result.execution.prompt_version, PROMPT_VERSION);
  assert.equal(result.execution.rule_version, RULE_VERSION);
  assert.ok(matchesSchema(output, OUTPUT_SCHEMA));
  assert.deepEqual(Object.fromEntries(Object.entries(output.extracted_fields).map(([key, f]) => [key, f.value])), expected.expected_values);
  assert.deepEqual(output.missing_fields.map(f => f.field_name).sort(), [...expected.expected_missing].sort());
  assert.deepEqual(output.warnings_and_holds.filter(w => w.code === 'AMBIGUOUS').map(w => w.source).sort(), [...expected.expected_ambiguity].sort());
  assert.ok(!output.warnings_and_holds.some(w => ['SCOPE_UNCERTAIN', 'MULTIPLE_ITEMS', 'OUT_OF_SCOPE'].includes(w.code)));
  assert.equal(output.status, 'needs_review');
  for (const field of Object.values(output.extracted_fields)) {
    assert.equal(field.human_status, 'pending');
    if (field.source_quote !== null) {
      const { source_id, start, end } = field.source_location;
      assert.equal(input()[source_id].slice(start, end), field.source_quote);
    }
  }
  assert.deepEqual((await service.get(output.audit_log_id)).output, output);
});

test('項目の曖昧フラグが欠けても、原文の来月半ばから具体的な日付を採用しない', () => {
  const model = partialResponse();
  model.fields.requested_delivery_date = { value: '2025-12-15', source_quote: '来月半ば', confidence: 1, ambiguous: false, candidate: null };
  const output = normalizeResult(input(), model);
  assert.equal(output.extracted_fields.requested_delivery_date.value, null);
  assert.equal(output.extracted_fields.product_name.value, expected.expected_values.product_name);
  assert.equal(output.extracted_fields.quantity.value, 1);
  assert.ok(output.warnings_and_holds.some(w => w.code === 'AMBIGUOUS' && w.source === 'requested_delivery_date'));
});

for (const [scope, code, reason] of [
  ['multiple', 'MULTIPLE_ITEMS', '複数商品'],
  ['out_of_scope', 'OUT_OF_SCOPE', '見積依頼の業務外']
]) test(`AIが${scope}なら1商品という入力や明示候補で上書きせず全体保留を維持する`, async () => {
  const model = partialResponse(); model.scope = scope;
  let calls = 0;
  const service = createExtractionService({ store: storeInMemory(), ai, fetchFn: async () => { calls++; return response(model); } });
  const result = await service.extract(input());
  assert.equal(calls, 1);
  const warning = result.output.warnings_and_holds.find(w => w.code === code);
  assert.ok(warning);
  assert.ok(warning.message.includes(reason));
  assert.ok(!warning.message.includes('いずれか'));
  assert.ok(Object.values(result.output.extracted_fields).every(f => f.value === null));
  assert.deepEqual(result.output.missing_fields, []); // Not evaluated, NOT "nothing missing".
  assert.equal(result.output.status, 'needs_review');
  await assert.rejects(service.review(result.output.audit_log_id, { revision: 1, acknowledged: true, values: {} }), /解除できません/);
});

test('前回同様という表現があっても複数商品なら部分抽出しない・外部呼出しもしない', async () => {
  const result = await createExtractionService({ store: storeInMemory(), ai, fetchFn: noFetch })
    .extract(input('multiple', { item_scope: 'single', request_text: input('multiple').request_text + '\n寸法と公差は前回同様です。' }));
  assert.ok(result.output.warnings_and_holds.some(w => w.code === 'MULTIPLE_ITEMS'));
  assert.ok(Object.values(result.output.extracted_fields).every(f => f.value === null));
  assert.equal(result.execution.external_attempts, 0);
});

test('元の実測不合格記録・事前期待値を上書きして合格にしない', () => {
  const measured = JSON.parse(readFileSync(new URL('../docs/extraction-step3-results-2026-08-31.json', import.meta.url), 'utf8'))
    .find(c => c.id === 'ambiguous').result;
  assert.equal(measured.execution.prompt_version, 'extraction-prompt-1.0');
  assert.ok(measured.output.warnings_and_holds.some(w => w.code === 'SCOPE_UNCERTAIN'));
  assert.equal(measured.output.extracted_fields.product_name.value, null);
  assert.notEqual(expected.expected_values.product_name, null);
});
