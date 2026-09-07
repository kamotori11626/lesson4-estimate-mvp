// Offline evidence only: no API, no DB, no real provider output and no file writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAMPLES } from '../src/extraction-samples.mjs';
import { blankModel, SCHEMA_VERSION, PROMPT_VERSION, RULE_VERSION } from '../src/extraction-schema.mjs';
import { normalizeResult } from '../src/extraction.mjs';

const expected = JSON.parse(readFileSync(new URL('../tests/fixtures/extraction-step3.expected.json', import.meta.url), 'utf8')).cases;
const cases = expected.map(e => {
  const { id, label, source, ...sample } = SAMPLES.find(s => s.id === e.id);
  const input = { ...sample, schema_version: SCHEMA_VERSION, mode: 'local', consent: false };
  const scope = {};
  const output = normalizeResult(input, blankModel('uncertain'), undefined, scope);
  assert.deepEqual(Object.fromEntries(Object.entries(output.extracted_fields).map(([k, f]) => [k, f.value])), e.expected_values);
  assert.deepEqual(output.missing_fields.map(f => f.field_name).sort(), [...e.expected_missing].sort());
  assert.deepEqual(output.warnings_and_holds.filter(w => w.code === 'AMBIGUOUS').map(w => w.source).sort(), [...e.expected_ambiguity].sort());
  assert.equal(scope.outcome, 'local_labelled_fallback');
  return { id, pass: true, scope_decision: scope, output };
});
console.log(JSON.stringify({ verification: 'OFFLINE_SYNTHETIC_UNCERTAIN_RESPONSE', external_attempts: 0,
  prompt_version: PROMPT_VERSION, rule_version: RULE_VERSION, checked_at: new Date().toISOString(), cases }, null, 2));
