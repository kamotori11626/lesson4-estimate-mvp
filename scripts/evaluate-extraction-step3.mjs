// Re-evaluate saved Step 3 evidence only. Never calls an external AI or writes to DB.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { OUTPUT_SCHEMA, matchesSchema } from '../src/extraction-schema.mjs';
import { SAMPLES } from '../src/extraction-samples.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const expected = read('../tests/fixtures/extraction-step3.expected.json').cases;
const retest = process.argv.includes('--retest-v11');
const retestV12 = process.argv.includes('--retest-v12');
if (retest && retestV12) throw new Error('Choose only one retest version');
const resultFile = retestV12 ? 'extraction-step3-retest-v12-results-2026-08-31.json'
  : retest ? 'extraction-step3-retest-v11-results-2026-08-31.json' : 'extraction-step3-results-2026-08-31.json';
const expectedVersion = retestV12 ? '1.2' : retest ? '1.1' : '1.0';
const actual = read(`../docs/${resultFile}`);
const equalSet = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());
const cases = expected.map(test => {
  const { output, execution, revision } = actual.find(row => row.id === test.id).result;
  const sample = SAMPLES.find(row => row.id === test.id);
  const differences = Object.entries(test.expected_values)
    .filter(([key, value]) => !isDeepStrictEqual(output.extracted_fields[key]?.value, value))
    .map(([field, value]) => ({ field, expected: value, actual: output.extracted_fields[field]?.value }));
  const quoteChecks = Object.values(output.extracted_fields).filter(field => field.source_quote !== null)
    .map(field => field.source_location !== null
      && sample[field.source_location.source_id]?.slice(field.source_location.start, field.source_location.end) === field.source_quote);
  const actualMissing = output.missing_fields.map(field => field.field_name);
  const actualAmbiguity = output.warnings_and_holds.filter(w => w.code === 'AMBIGUOUS').map(w => w.source);
  const result = {
    id: test.id, source_rfq: test.source_rfq,
    request_id: output.request_id, audit_log_id: output.audit_log_id,
    schema_pass: matchesSchema(output, OUTPUT_SCHEMA),
    value_matches: Object.keys(test.expected_values).length - differences.length,
    value_total: Object.keys(test.expected_values).length, differences,
    missing_pass: equalSet(actualMissing, test.expected_missing),
    expected_missing: test.expected_missing, actual_missing: actualMissing,
    ambiguity_pass: equalSet(actualAmbiguity, test.expected_ambiguity),
    expected_ambiguity: test.expected_ambiguity, actual_ambiguity: actualAmbiguity,
    ambiguous_fields_without_source: actualAmbiguity.filter(key => output.extracted_fields[key]?.source_quote === null),
    populated_fields_without_source: Object.entries(output.extracted_fields).filter(([, field]) => field.value !== null && (field.source_quote === null || field.source_location === null)).map(([key]) => key),
    quote_checks: quoteChecks.length, quotes_pass: quoteChecks.every(Boolean),
    review_state_pass: output.status === 'needs_review' && Object.values(output.extracted_fields).every(f => f.human_status === 'pending'),
    warning_codes: output.warnings_and_holds.map(w => w.code),
    external_attempts: execution.external_attempts,
    connection_pass: execution.mode === 'gemini' && execution.model === 'gemini-3.5-flash-lite'
      && execution.external_attempts === 1 && execution.verified_external_extraction === true && revision === 1,
    version_pass: execution.prompt_version === `extraction-prompt-${expectedVersion}` && execution.rule_version === `extraction-rules-${expectedVersion}`,
    prompt_version: execution.prompt_version, rule_version: execution.rule_version,
    elapsed_ms: Date.parse(execution.completed_at) - Date.parse(execution.started_at)
  };
  result.pass = result.schema_pass && differences.length === 0 && result.missing_pass
    && result.ambiguity_pass && result.quotes_pass && result.review_state_pass && result.connection_pass && result.version_pass;
  // 1.2 acceptance explicitly includes the original-evidence defect under test.
  // Preserve the historical 1.0/1.1 scoring when re-reading their saved reports.
  if (retestV12) result.pass = result.pass && result.ambiguous_fields_without_source.length === 0
    && result.populated_fields_without_source.length === 0;
  return result;
});
const report = {
  date_jst: '2026-08-31', source: retestV12
    ? 'Saved local backend API output after actual Gemini calls; not raw provider response'
    : 'Saved browser output after actual Gemini calls; not raw provider response',
  result_file: resultFile,
  cases, summary: {
    cases_passed: cases.filter(c => c.pass).length, cases_total: cases.length,
    schema_passed: cases.filter(c => c.schema_pass).length,
    value_matches: cases.reduce((n, c) => n + c.value_matches, 0), value_total: 27,
    llm_field_matches: cases.reduce((n, c) => n + 8 - c.differences.filter(d => d.field !== 'customer_name').length, 0), llm_field_total: 24,
    external_attempts: cases.reduce((n, c) => n + c.external_attempts, 0)
  }
};
if (process.argv.includes('--db')) {
  const { pool } = await import('../src/db.mjs');
  try {
    const ids = cases.map(c => c.audit_log_id);
    const runs = await pool.query('SELECT run_id, input_payload, output_payload, execution, revision FROM extraction_runs WHERE run_id = ANY($1::uuid[])', [ids]);
    const events = await pool.query('SELECT run_id,event_type FROM extraction_events WHERE run_id = ANY($1::uuid[]) ORDER BY id', [ids]);
    const drafts = await pool.query('SELECT count(*)::int AS count FROM extraction_review_drafts WHERE run_id = ANY($1::uuid[])', [ids]);
    report.database = {
      rows: runs.rowCount, review_drafts: drafts.rows[0].count,
      checks: actual.map(({id, result}) => {
        const row = runs.rows.find(r => r.run_id === result.output.audit_log_id);
        const sample = SAMPLES.find(s => s.id === id);
        return {
          id,
          [retestV12 ? 'output_matches_api' : 'output_matches_browser']: !!row && isDeepStrictEqual(row.output_payload, result.output),
          [retestV12 ? 'execution_matches_api' : 'execution_matches_browser']: !!row && isDeepStrictEqual(row.execution, result.execution),
          revision: row?.revision,
          input_matches_sample: !!row && ['customer_name','received_at','request_channel','case_type','item_scope','request_text'].every(key => row.input_payload[key] === sample[key]),
          events: events.rows.filter(e => e.run_id === result.output.audit_log_id).map(e => e.event_type)
        };
      })
    };
  } finally { await pool.end(); }
}
console.log(JSON.stringify(report, null, 2));
// Nonzero means the observed extraction did not meet all predeclared expectations.
if (cases.some(c => !c.pass)) process.exitCode = 1;
