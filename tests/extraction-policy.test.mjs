import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAMPLES } from '../src/extraction-samples.mjs';
import { blankModel, matchesSchema, OUTPUT_SCHEMA, SCHEMA_VERSION } from '../src/extraction-schema.mjs';
import { extractLocally, normalizeResult, scopeWarning, validateInput } from '../src/extraction.mjs';
import { createExtractionService } from '../src/extraction-service.mjs';
import { fieldContexts, locateQuote, quantityMentions } from '../src/extraction-evidence.mjs';

function input(id = 'ambiguous', extra = {}) {
  const { id: _, source, label, ...data } = SAMPLES.find(s => s.id === id);
  return { schema_version: SCHEMA_VERSION, ...data, mode: 'local', consent: false, ...extra };
}
const noFetch = () => assert.fail('External transmission is forbidden');
const ai = { provider: 'gemini', model: 'test-only', apiKey: 'dummy-not-a-real-key' };
function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async start(id, data, output, execution) { rows.set(id, structuredClone({ input_payload: data, output_payload: output, execution, revision: 0 })); },
    async finish(id, output, execution) { Object.assign(rows.get(id), structuredClone({ output_payload: output, execution, revision: 1 })); },
    async get(id) { return structuredClone(rows.get(id)); },
    async saveReview(id, revision, output) { const row = rows.get(id); if (row.revision !== revision) return null; row.output_payload = structuredClone(output); return ++row.revision; }
  };
}
const values = output => Object.fromEntries(Object.entries(output.extracted_fields).map(([key, field]) => [key, field.value]));
const has = (output, code, source) => output.warnings_and_holds.some(w => w.code === code && (!source || w.source === source));
function proposed(key, value, quote, ambiguous = false) {
  const model = blankModel();
  model.fields[key] = { value, source_quote: quote, confidence: 1, ambiguous, candidate: null };
  return model;
}

test('観測された1.1の不合格パターンを再現：材質の根拠なし警告を棄却し、寸法・公差の原文を回復', () => {
  const saved = JSON.parse(readFileSync(new URL('../docs/extraction-step3-retest-v11-results-2026-08-31.json', import.meta.url), 'utf8'))
    .find(c => c.id === 'ambiguous').result.output;
  // Raw provider JSON was not retained. This is a representative test response reconstructed
  // from the observed normalized fields/warnings, not a claim to replay the exact raw response.
  const model = blankModel();
  for (const key of Object.keys(model.fields)) {
    const f = saved.extracted_fields[key];
    model.fields[key] = { value: f.value, source_quote: f.source_quote, confidence: f.confidence,
      ambiguous: has(saved, 'AMBIGUOUS', key), candidate: null };
  }
  const output = normalizeResult(input(), model);
  const expected = JSON.parse(readFileSync(new URL('./fixtures/extraction-step3.expected.json', import.meta.url), 'utf8')).cases.find(c => c.id === 'ambiguous');
  assert.deepEqual(values(output), expected.expected_values);
  assert.deepEqual(output.missing_fields.map(f => f.field_name).sort(), [...expected.expected_missing].sort());
  assert.deepEqual(output.warnings_and_holds.filter(w => w.code === 'AMBIGUOUS').map(w => w.source).sort(), [...expected.expected_ambiguity].sort());
  assert.ok(has(output, 'AMBIGUITY_UNVERIFIED', 'material'));
  assert.match(output.missing_fields.find(f => f.field_name === 'material').reason, /^情報不足/);
  for (const key of ['dimensions', 'tolerance']) {
    const field = output.extracted_fields[key];
    assert.equal(field.source_quote, '寸法と公差は前回同様です');
    assert.equal(input().request_text.slice(field.source_location.start, field.source_location.end), field.source_quote);
  }
  assert.ok(matchesSchema(output, OUTPUT_SCHEMA));
});

test('項目名を限定して引用を回復する：品名や依頼冒頭の前回同様を材質の根拠にしない', () => {
  const data = input('ambiguous');
  for (const quote of [null, 'MCナイロンプレート300', '前回同様のお見積りをお願いします']) {
    const output = normalizeResult(data, proposed('material', null, quote, true));
    assert.ok(!has(output, 'AMBIGUOUS', 'material'));
    assert.ok(has(output, 'AMBIGUITY_UNVERIFIED', 'material'));
    assert.equal(output.extracted_fields.material.value, null);
  }
});

test('AIが曖昧フラグを付け忘れても、明示された共同仕様の要確認と引用を保持する', () => {
  const data = input('clear', { request_text: '品番: TEST-01\n数量: 7個\n寸法・公差：未定' });
  const output = normalizeResult(data, extractLocally(data.request_text));
  assert.equal(output.extracted_fields.product_code.value, 'TEST-01');
  assert.equal(output.extracted_fields.quantity.value, 7);
  for (const key of ['dimensions', 'tolerance']) {
    assert.ok(has(output, 'AMBIGUOUS', key));
    assert.equal(output.extracted_fields[key].source_quote, '寸法・公差：未定');
  }
});

test('未記載は情報不足、明示された不明は曖昧として別の理由を表示する', () => {
  const data = input('missing');
  const output = normalizeResult(data, extractLocally(data.request_text));
  assert.match(output.missing_fields.find(f => f.field_name === 'material').reason, /^情報不足/);
  assert.match(output.missing_fields.find(f => f.field_name === 'tolerance').reason, /^曖昧/);
  assert.ok(!has(output, 'AMBIGUOUS', 'material'));
});

for (const text of ['数量: 100個 → 200個', '数量: 100個\n数量: 200個', '数量: 100個（訂正：200個）']) {
  test(`単一商品に紐づく数量の矛盾は両方を表示し、品番を保持する：${text}`, async () => {
    const data = input('clear', { request_text: `品番: TEST-01\n${text}` });
    const output = (await createExtractionService({ store: memoryStore(), ai, fetchFn: noFetch }).extract(data)).output;
    assert.equal(output.extracted_fields.product_code.value, 'TEST-01');
    assert.equal(output.extracted_fields.quantity.value, null);
    assert.ok(has(output, 'CONFLICTING_VALUES', 'quantity'));
    const message = output.warnings_and_holds.find(w => w.code === 'CONFLICTING_VALUES' && w.source === 'quantity').message;
    assert.ok(message.includes('100個') && message.includes('200個'));
    assert.match(output.missing_fields.find(f => f.field_name === 'quantity').reason, /^矛盾/);
  });
}

test('数量が複数商品に属する可能性が残る自由文は全体保留を維持し、根拠を併記する', async () => {
  const data = input('clear', { request_text: '商品Aを100個、商品Bを200個見積ください。' });
  const result = await createExtractionService({ store: memoryStore(), ai, fetchFn: noFetch }).extract(data);
  assert.ok(has(result.output, 'ITEM_COUNT_UNCERTAIN'));
  assert.ok(has(result.output, 'CONFLICTING_VALUES', 'quantity'));
  assert.ok(Object.values(result.output.extracted_fields).every(f => f.value === null));
  assert.equal(result.execution.external_attempts, 0);
});

test('実際の複数商品は訂正表現があっても全体保留・外部送信なし', async () => {
  const result = await createExtractionService({ store: memoryStore(), ai, fetchFn: noFetch })
    .extract(input('multiple', { item_scope: 'single', request_text: input('multiple').request_text + '\n数量: 30個（訂正）' }));
  assert.ok(has(result.output, 'MULTIPLE_ITEMS'));
  assert.ok(!has(result.output, 'CONFLICTING_VALUES'));
  assert.ok(Object.values(result.output.extracted_fields).every(f => f.value === null));
});

test('単位が同じ数量訂正を単位自体の矛盾と判定しない', () => {
  const data = input('clear', { request_text: '品番: TEST-01\n数量: 100個（訂正：200個）' });
  const output = normalizeResult(data, extractLocally(data.request_text));
  assert.ok(has(output, 'CONFLICTING_VALUES', 'quantity'));
  assert.ok(!has(output, 'CONFLICTING_VALUES', 'quantity_unit'));
});

test('長い引用を自動回復して出力スキーマを破壊しない', () => {
  const data = input('clear', { request_text: `品番: TEST-01\n寸法: 前回同様${'あ'.repeat(1100)}` });
  const output = normalizeResult(data, blankModel());
  assert.ok(matchesSchema(output, OUTPUT_SCHEMA));
  assert.equal(output.extracted_fields.dimensions.value, null);
  assert.ok(has(output, 'EVIDENCE_INVALID', 'dimensions'));
});

test('材質・希望納期の矛盾も自動選択せず、値をnullとし両方の記載を保持する', () => {
  const data = input('clear', { request_text: '品番: TEST-01\n材質: SUS304\n材質: SUS316\n希望納期: 2026-09-01\n希望納期: 2026-09-02' });
  const output = normalizeResult(data, extractLocally(data.request_text));
  for (const key of ['material', 'requested_delivery_date']) {
    assert.equal(output.extracted_fields[key].value, null);
    assert.ok(has(output, 'CONFLICTING_VALUES', key));
  }
});

for (const [key, text] of [['quantity', '数量: 0個'], ['quantity', '数量: -1個'], ['requested_delivery_date', '希望納期: 2026-02-30']]) {
  test(`不正値は曖昧と混同せず無効と表示する：${text}`, () => {
    const data = input('clear', { request_text: `品番: TEST-01\n${text}` });
    const output = normalizeResult(data, extractLocally(data.request_text));
    assert.equal(output.extracted_fields[key].value, null);
    assert.ok(has(output, 'INVALID_VALUE', key));
    assert.match(output.missing_fields.find(f => f.field_name === key).reason, /^無効/);
  });
}

test('単位がない場合は数量を保持し、単位は推測せず未確認と表示する', () => {
  const data = input('clear', { request_text: '品番: TEST-01\n数量: 10' });
  const output = normalizeResult(data, extractLocally(data.request_text));
  assert.equal(output.extracted_fields.quantity.value, 10);
  assert.equal(output.extracted_fields.quantity_unit.value, null);
  assert.ok(has(output, 'UNIT_MISSING', 'quantity_unit'));
});

test('単位が別行でも数量と重複矛盾にしない、寸法を別商品の数量と混同しない', () => {
  const data = input('clear', { request_text: '品番: TEST-01\n数量: 10\n単位: 個\n寸法: 20 mm\n公差: +0.02/-0.01 mm' });
  assert.equal(scopeWarning(data), null);
  const output = normalizeResult(data, extractLocally(data.request_text));
  assert.equal(output.extracted_fields.quantity_unit.value, '個');
  assert.ok(!has(output, 'CONFLICTING_VALUES'));
  const other = input('clear', { request_text: '品番: TEST-01\n数量: 10個\n単位: 個\n寸法: 20 mm' });
  assert.equal(scopeWarning(other), null);
  assert.equal(quantityMentions(other.request_text).length, 1);
  assert.equal(normalizeResult(other, extractLocally(other.request_text)).extracted_fields.quantity_unit.value, '個');
});

test('kgをgと誤抽出したり、未対応単位を採用したりしない', () => {
  for (const [value, quote, text] of [['g', '1kg', '数量: 1kg'], ['pcs', 'pcs', '数量: 10 pcs']]) {
    const data = input('clear', { request_text: `品番: TEST-01\n${text}` });
    const output = normalizeResult(data, proposed('quantity_unit', value, quote));
    assert.equal(output.extracted_fields.quantity_unit.value, null);
    assert.ok(has(output, 'UNIT_UNCONFIRMED', 'quantity_unit'));
  }
});

test('原文の別項目や存在しない引用を根拠として採用しない、同じ文字列なら該当項目の位置を選ぶ', () => {
  const text = '品名: SUS304カバー\n材質: SUS304';
  const hit = locateQuote(text, 'SUS304', 'material');
  assert.equal(hit.start, text.lastIndexOf('SUS304'));
  assert.equal(fieldContexts('品名: PPSカバー80', 'material').length, 0);
  const data = input('clear', { request_text: '品名: PPSカバー80\n数量: 10個' });
  for (const quote of ['PPS', '存在しない']) {
    const output = normalizeResult(data, proposed('material', 'PPS', quote));
    assert.equal(output.extracted_fields.material.value, null);
    assert.ok(has(output, 'EVIDENCE_INVALID', 'material'));
  }
});

test('本文だけでなく顧客欄の認証情報も保存・送信前に拒否する', () => {
  assert.throws(() => validateInput(input('clear', { customer_name: 'API_KEY=dummy-credential' })), /認証情報/);
});

test('未許可データ・API障害・不正出力・保存障害は情報不足に偽装しない', async () => {
  const unapproved = await createExtractionService({ store: memoryStore(), ai, fetchFn: noFetch })
    .extract(input('clear', { mode: 'gemini', consent: true, request_text: input('clear').request_text + '\n単価: 999円' }));
  assert.equal(unapproved.output.status, 'error');
  assert.equal(unapproved.execution.external_attempts, 0);
  for (const reply of [{ ok: false, status: 503 }, { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] }) }]) {
    let calls = 0;
    const result = await createExtractionService({ store: memoryStore(), ai, fetchFn: async () => { calls++; return reply; } })
      .extract(input('clear', { mode: 'gemini', consent: true }));
    assert.equal(calls, 1);
    assert.equal(result.output.status, 'error');
    assert.deepEqual(result.output.missing_fields, []);
  }
  const store = memoryStore(); store.finish = async () => { throw new Error('storage failed'); };
  const failed = await createExtractionService({ store, ai, fetchFn: noFetch }).extract(input());
  assert.equal(failed.output.status, 'error');
  assert.equal(failed.output.audit_log_id, null);
});

test('修正保存でも未対応単位を拒否し、保存後は未確認下書きと初回警告を維持する', async () => {
  const service = createExtractionService({ store: memoryStore(), ai, fetchFn: noFetch });
  const first = await service.extract(input());
  await assert.rejects(service.review(first.output.audit_log_id,
    { revision: 1, acknowledged: true, values: { ...values(first.output), quantity_unit: 'pcs' } }), /数量単位/);
  const after = await service.review(first.output.audit_log_id,
    { revision: 1, acknowledged: true, values: { ...values(first.output), quantity_unit: null } });
  assert.equal(after.output.status, 'needs_review');
  assert.ok(Object.values(after.output.extracted_fields).every(f => f.human_status === 'pending'));
  assert.ok(has(after.output, 'UNIT_MISSING', 'quantity_unit'));
  assert.ok(has(after.output, 'AMBIGUOUS', 'dimensions'));
});
