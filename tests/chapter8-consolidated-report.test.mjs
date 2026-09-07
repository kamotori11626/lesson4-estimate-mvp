import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const reportUrl = new URL('../docs/chapter8-test-results-2026-09-06.json', import.meta.url);

test('Chapter 8の主報告JSONはMarkdownと同じ12件・9/3/0を保持する', async () => {
  const report = JSON.parse(await readFile(reportUrl, 'utf8'));
  const expectedIds = [
    'N-01', 'N-02', 'N-03', 'N-COMP-01',
    'E-01', 'E-02', 'E-03', 'E-04',
    'P-01', 'P-02', 'P-03', 'P-04'
  ];

  assert.equal(report.report_version, 'chapter8-test-results-1.1');
  assert.deepEqual(report.results.map(result => result.id), expectedIds);
  assert.equal(new Set(report.results.map(result => result.id)).size, 12);
  assert.deepEqual(report.summary, { 合格: 9, 条件付き合格: 3, 不合格: 0 });
});

test('追加2件の個別検証記録を主報告JSONから追跡できる', async () => {
  const report = JSON.parse(await readFile(reportUrl, 'utf8'));
  const sources = report.supplementary_sources || [];
  const normal = report.results.find(result => result.id === 'N-COMP-01');
  const routing = report.results.find(result => result.id === 'P-04');

  assert.equal(sources.length, 2);
  assert.ok(sources.some(source => source.path === 'docs/chapter8-normal-comparable-result-2026-09-06.json'));
  assert.ok(sources.some(source => source.path === 'docs/process-type-routing-result-2026-09-06.json'));
  assert.equal(normal?.assessment.result, '合格');
  assert.equal(routing?.assessment.result, '合格');
  assert.equal(normal?.actual.evidence_file, 'docs/chapter8-normal-comparable-result-2026-09-06.json');
  assert.equal(routing?.actual.evidence_file, 'docs/process-type-routing-result-2026-09-06.json');
});

test('P-03は必須項目欠落と混同せず禁止表現だけを検出する', async () => {
  const report = JSON.parse(await readFile(reportUrl, 'utf8'));
  const prohibited = report.results.find(result => result.id === 'P-03');
  const codes = prohibited?.actual.prohibited_quality_gate.violations.map(violation => violation.code).sort();

  assert.deepEqual(codes, ['DELIVERY_GUARANTEE', 'PRICE_ASSERTION']);
  assert.equal(prohibited?.actual.prohibited_quality_gate.checks.source_consistency, true);
  assert.equal(prohibited?.actual.prohibited_quality_gate.checks.audience_appropriate, true);
  assert.equal(prohibited?.actual.prohibited_quality_gate.checks.auto_send, false);
});
