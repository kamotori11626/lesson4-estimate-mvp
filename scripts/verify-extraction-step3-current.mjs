// Re-score ALL stored current-rule Gemini runs and test the current local API.
// Never sends a request to an external AI, reloads CSV into DB, or edits old results.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import pg from 'pg';
import { config } from '../src/config.mjs';
import { FIELD_LABELS, OUTPUT_SCHEMA, SCHEMA_VERSION, RULE_VERSION, PROMPT_VERSION, matchesSchema } from '../src/extraction-schema.mjs';
import { SAMPLES } from '../src/extraction-samples.mjs';

assert.equal(process.argv[2], '--local-and-stored-only');
const expected = JSON.parse(await fs.readFile(new URL('../tests/fixtures/extraction-step3.expected.json', import.meta.url), 'utf8')).cases;
const hash = value => createHash('sha256').update(value).digest('hex');
const asInput = sample => {
  const { id, label, source, ...input } = sample;
  return { ...input, schema_version: SCHEMA_VERSION, mode: 'local', consent: false };
};
const keys = Object.keys(FIELD_LABELS);
const sameSet = (a, b) => equal([...a].sort(), [...b].sort());
const sampleKeys = ['customer_name', 'received_at', 'request_channel', 'case_type', 'item_scope', 'request_text'];
function evaluate(id, output, execution, revision, input) {
  const e = expected.find(row => row.id === id);
  const sample = SAMPLES.find(row => row.id === id);
  const values = Object.fromEntries(Object.entries(output.extracted_fields).map(([key, field]) => [key, field.value]));
  const differences = keys.filter(key => !equal(values[key], e.expected_values[key])).map(key => ({ field: key, expected: e.expected_values[key], actual: values[key] }));
  const actualMissing = output.missing_fields.map(f => f.field_name);
  const actualAmbiguity = output.warnings_and_holds.filter(w => w.code === 'AMBIGUOUS').map(w => w.source);
  const quoteProblems = Object.entries(output.extracted_fields).filter(([, f]) => {
    if (f.value !== null && (!f.source_quote || !f.source_location)) return true;
    if (f.source_quote === null) return false;
    return !f.source_location || sample[f.source_location.source_id]?.slice(f.source_location.start, f.source_location.end) !== f.source_quote;
  }).map(([key]) => key);
  const ambiguityWithoutQuote = actualAmbiguity.filter(key => !output.extracted_fields[key]?.source_quote);
  const checks = {
    coverage: sameSet(Object.keys(output.extracted_fields), keys)
      && Object.values(output.extracted_fields).every(f => sameSet(Object.keys(f), ['value', 'source_quote', 'source_location', 'confidence', 'human_status'])),
    accuracy: differences.length === 0,
    missing_information: sameSet(actualMissing, e.expected_missing) && sameSet(actualAmbiguity, e.expected_ambiguity),
    fixed_schema: matchesSchema(output, OUTPUT_SCHEMA),
    source_evidence: quoteProblems.length === 0 && ambiguityWithoutQuote.length === 0,
    pending_review: output.status === 'needs_review' && Object.values(output.extracted_fields).every(f => f.human_status === 'pending'),
    sample_input_match: sampleKeys.every(key => input[key] === sample[key]),
    current_version: execution.rule_version === RULE_VERSION && execution.prompt_version === PROMPT_VERSION,
    unedited_extraction: revision === 1
  };
  const pass = Object.values(checks).every(Boolean);
  return { id, source_rfq: e.source_rfq, request_id: output.request_id, run_id: output.audit_log_id,
    started_at: execution.started_at, model: execution.model, method: execution.extraction_method,
    external_attempts_at_original_execution: execution.external_attempts,
    checks, pass, values, expected_values: e.expected_values, differences,
    actual_missing: actualMissing, expected_missing: e.expected_missing,
    actual_ambiguity: actualAmbiguity, expected_ambiguity: e.expected_ambiguity,
    quote_problems: quoteProblems, ambiguous_fields_without_quote: ambiguityWithoutQuote,
    actual_ai_extraction_pass: pass && execution.mode === 'gemini' && execution.extraction_method === 'gemini_fields'
      && execution.verified_external_extraction === true && execution.verified_external_response === true && execution.external_attempts === 1 };
}

const csvFile = new URL('../data/raw/12_見積依頼ログ.csv', import.meta.url);
const csv = await fs.readFile(csvFile);
const lines = csv.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
const headers = lines[0].split(',');
// Only audit the three observed unquoted source records. Fail, do not misparse quoted data.
const sourceRows = expected.map(e => {
  const lineIndex = lines.findIndex(line => line.startsWith(`${e.source_rfq},`));
  assert.ok(lineIndex > 0);
  assert.ok(!lines[lineIndex].includes('"'), 'Quoted record requires a CSV parser');
  const fields = lines[lineIndex].split(',');
  return { sample_id: e.id, csv_line_including_header: lineIndex + 1,
    rfq_id: fields[0], received_date: fields[1], product_text: fields[5], quantity: Number(fields[6]), requested_delivery_date: fields[7],
    column_count: fields.length, header_column_count: headers.length };
});
const downloadBase = '/Users/shohei/Downloads';
const suppliedDirName = 'Section4 模擬実習 Lesson2 業務理解 + 業務棚卸し 配布データ';
const suppliedDir = (await fs.readdir(downloadBase)).find(name => name.normalize('NFC') === suppliedDirName);
assert.ok(suppliedDir, 'User-supplied original CSV folder not found');
const originalDir = path.join(downloadBase, suppliedDir);
const originalName = (await fs.readdir(originalDir)).find(name => name.normalize('NFC') === '12_見積依頼ログ.csv');
assert.ok(originalName);
const original = await fs.readFile(path.join(originalDir, originalName));
assert.ok(csv.equals(original), 'Project copy differs from supplied original');
for (const row of sourceRows) {
  const e = expected.find(c => c.id === row.sample_id);
  const sample = SAMPLES.find(c => c.id === row.sample_id);
  assert.equal(row.quantity, e.expected_values.quantity);
  assert.ok(row.product_text.includes(e.expected_values.product_code || e.expected_values.product_name));
  assert.equal(row.received_date, sample.received_at.slice(0, 10));
  if (row.sample_id !== 'ambiguous') assert.equal(row.requested_delivery_date, e.expected_values.requested_delivery_date);
}

const pool = new pg.Pool(config.pg);
const report = { checked_at: new Date().toISOString(), curriculum: 'https://master.tech-camp.in/v2/curriculums/15327',
  criteria: ['coverage', 'accuracy', 'missing_information', 'fixed_schema'], new_external_ai_requests: 0,
  source: { filename: '12_見積依頼ログ.csv', sha256: hash(csv), original_copy_identical: true,
    rows: lines.length - 1, headers, original_email_body_present: false, rows_used: sourceRows,
    caveat: 'Reconstructed labelled test emails, not original emails. Customer names, greeting, units, time-of-day and case classification are test data. Ambiguous delivery is deliberately replaced; do not treat it as the CSV date.' },
  stored_actual_ai: [], local_current: [], scope_controls: [] };
const localApi = async (suffix, options) => fetch(`http://127.0.0.1:4173/api/extraction${suffix}`, { redirect: 'error', signal: AbortSignal.timeout(10000), ...options });
try {
  const settings = await (await localApi('/config')).json();
  assert.deepEqual(settings.samples, SAMPLES);
  assert.deepEqual(settings.output_schema, OUTPUT_SCHEMA);
  const stored = (await pool.query("SELECT * FROM public.extraction_runs WHERE execution->>'mode'='gemini' AND execution->>'rule_version'=$1 ORDER BY created_at", [RULE_VERSION])).rows;
  report.stored_actual_ai_records_found = stored.length;
  for (const row of stored) {
    const sample = SAMPLES.find(s => sampleKeys.every(k => s[k] === row.input_payload[k]));
    assert.ok(sample && expected.some(e => e.id === sample.id), 'Unexpected current-rule AI run: must be reported rather than silently excluded');
    const result = evaluate(sample.id, row.output_payload, row.execution, row.revision, row.input_payload);
    const fromApi = await (await localApi(`/${row.run_id}`)).json();
    result.api_matches_db = equal(fromApi.output, row.output_payload) && equal(fromApi.execution, row.execution);
    result.events = (await pool.query('SELECT event_type FROM public.extraction_events WHERE run_id=$1 ORDER BY id', [row.run_id])).rows.map(r => r.event_type);
    result.pass &&= result.api_matches_db && equal(result.events, ['started', 'finished']);
    result.actual_ai_extraction_pass &&= result.pass;
    report.stored_actual_ai.push(result);
  }
  assert.ok(expected.every(e => report.stored_actual_ai.some(r => r.id === e.id)), 'Fewer than 3 distinct stored actual-AI examples');
  for (const e of expected) {
    const input = asInput(SAMPLES.find(s => s.id === e.id));
    const response = await localApi('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const { output, execution, revision } = await response.json();
    const result = evaluate(e.id, output, execution, revision, input);
    const row = (await pool.query('SELECT * FROM public.extraction_runs WHERE run_id=$1', [output.audit_log_id])).rows[0];
    result.http_status = response.status;
    result.api_matches_db = equal(row.output_payload, output) && equal(row.execution, execution);
    result.pass &&= response.status === 200 && result.api_matches_db && execution.mode === 'local' && execution.external_attempts === 0;
    report.local_current.push(result);
  }
  for (const [id, expectedCode] of [['multiple', 'MULTIPLE_ITEMS'], ['unrelated', 'OUT_OF_SCOPE']]) {
    const response = await localApi('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(asInput(SAMPLES.find(s => s.id === id))) });
    const { output, execution } = await response.json();
    report.scope_controls.push({ id, run_id: output.audit_log_id, schema_pass: matchesSchema(output, OUTPUT_SCHEMA),
      expected_code: expectedCode, warnings: output.warnings_and_holds.map(w => w.code), external_attempts: execution.external_attempts,
      pass: matchesSchema(output, OUTPUT_SCHEMA) && output.warnings_and_holds.some(w => w.code === expectedCode)
        && Object.values(output.extracted_fields).every(f => f.value === null) && execution.external_attempts === 0 });
  }
  const historical = report.stored_actual_ai;
  report.summary = { stored_actual_ai_pass: historical.filter(c => c.actual_ai_extraction_pass).length, stored_actual_ai_total: historical.length,
    distinct_actual_ai_inputs: new Set(historical.map(c => c.id)).size,
    stored_field_matches_including_nulls: historical.reduce((sum, c) => sum + keys.length - c.differences.length, 0), stored_field_total: historical.length * keys.length,
    local_current_pass: report.local_current.filter(c => c.pass).length, local_current_total: report.local_current.length,
    scope_controls_pass: report.scope_controls.filter(c => c.pass).length, scope_controls_total: report.scope_controls.length,
    pass: historical.every(c => c.actual_ai_extraction_pass) && report.local_current.every(c => c.pass) && report.scope_controls.every(c => c.pass) };
  console.log(JSON.stringify(report));
  if (!report.summary.pass) process.exitCode = 1;
} finally { await pool.end(); }
