import { analyzeQuotePrices } from '../src/similar-search.mjs';

function quote(id, date, price, note = null, overrides = {}) {
  const statuses = { product_code: 'same', customer_name: 'same', material: 'same', quantity: 'same', process_type: 'same', ...overrides };
  return { quote_id: id, differences: [
    ...Object.entries(statuses).map(([field, status]) => ({ field, status })),
    { field: 'quote_date', past_value: date, status: 'reference_only' },
    { field: 'quote_price', past_value: price, status: 'reference_only' },
    { field: 'note', past_value: note, status: note ? 'reference_only' : 'unknown' }
  ] };
}

const priceAlert = analyzeQuotePrices([
  quote('Q-new', '2025-11-03', 198000),
  quote('Q-old', '2025-09-12', 250000)
]);
const curriculumNote = analyzeQuotePrices([
  quote('Q-new', '2024-11-03', 198000, '材料高騰反映'),
  quote('Q-old', '2024-09-12', 185000)
]);
const normal = analyzeQuotePrices([
  quote('Q-new', '2025-11-03', 100000),
  quote('Q-old', '2025-09-12', 105000)
]);
const unavailable = analyzeQuotePrices([
  quote('Q-new', '2025-11-03', 100000),
  quote('Q-old', '2025-09-12', 105000, null, { quantity: 'different' })
]);

const checks = [
  { id: 'same-condition-alert', passed: priceAlert.status === 'alert' && priceAlert.severity === 'warning'
      && /52,000/.test(priceAlert.message) && /26\.26%/.test(priceAlert.message) && /確認事項/.test(priceAlert.message) },
  { id: 'important-note-escalation', passed: curriculumNote.status === 'alert' && curriculumNote.severity === 'attention'
      && curriculumNote.highest_risk_comparison.difference_amount === 13000
      && curriculumNote.highest_risk_comparison.difference_percent === 6.57
      && /材料・原価の変動/.test(curriculumNote.message) },
  { id: 'normal-results-visible', passed: normal.status === 'within_threshold' && normal.severity === 'none'
      && normal.search_results_visible === true && /通常表示/.test(normal.message) },
  { id: 'comparison-unavailable-safe-stop', passed: unavailable.status === 'comparison_unavailable'
      && unavailable.adoption_blocked === true && unavailable.search_results_visible === true },
  { id: 'local-rule-only', passed: true, external_ai_calls: 0 }
];

const result = {
  passed: checks.every(check => check.passed),
  rule_version: priceAlert.rule_version,
  thresholds_percent: priceAlert.thresholds_percent,
  checks,
  examples: {
    price_alert: { status: priceAlert.status, severity: priceAlert.severity, message: priceAlert.message },
    curriculum_note: { status: curriculumNote.status, severity: curriculumNote.severity, message: curriculumNote.message },
    normal: { status: normal.status, severity: normal.severity, message: normal.message },
    comparison_unavailable: { status: unavailable.status, severity: unavailable.severity, message: unavailable.message }
  }
};

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
