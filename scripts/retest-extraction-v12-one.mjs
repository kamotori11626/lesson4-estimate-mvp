// Explicitly authorized live test. ONE local API POST per invocation; no retries.
// The application owns the API key, masking, schema, prompt, and DB audit writes.
// Never rerun after an uncertain response: inspect the DB first.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SAMPLES } from '../src/extraction-samples.mjs';
import { SCHEMA_VERSION, PROMPT_VERSION, RULE_VERSION } from '../src/extraction-schema.mjs';

const id = process.argv[2];
assert.ok(['clear', 'missing', 'ambiguous'].includes(id), 'Only the three agreed samples are allowed');
assert.equal(process.argv[3], '--send-one-real-call', 'Explicit live-call flag required');
assert.equal(PROMPT_VERSION, 'extraction-prompt-1.2');
assert.equal(RULE_VERSION, 'extraction-rules-1.2');
assert.ok(!existsSync(new URL(`../docs/extraction-step3-retest-v12-${id}-2026-08-31.json`, import.meta.url)), 'Saved result exists; do not resend');
const base = 'http://127.0.0.1:4173';
const settingsResponse = await fetch(`${base}/api/extraction/config`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
assert.equal(settingsResponse.status, 200);
const settings = await settingsResponse.json();
assert.equal(settings.model, 'gemini-3.5-flash-lite');
assert.equal(settings.gemini_configured, true);
assert.equal(settings.external_policy, 'exact_anonymous_samples_only');
assert.deepEqual(settings.samples, SAMPLES);
const { id: _, label, source, ...sample } = SAMPLES.find(s => s.id === id);
const startedAt = new Date().toISOString();
const response = await fetch(`${base}/api/extraction`, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ schema_version: SCHEMA_VERSION, ...sample, mode: 'gemini', consent: true })
});
const result = await response.json();
console.log(JSON.stringify({ id, transport: 'local_backend_api', local_http_status: response.status,
  local_request_started_at: startedAt, result }, null, 2));
