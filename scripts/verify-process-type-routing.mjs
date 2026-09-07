import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const baseUrl = process.env.MVP_BASE_URL || 'http://127.0.0.1:4173';
const outputUrl = new URL('../docs/process-type-routing-result-2026-09-06.json', import.meta.url);

async function api(path, body) {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${data.code || ''} ${data.error || 'API error'}`);
  return data;
}

async function apiError(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  assert.equal(response.ok, false);
  return { status: response.status, ...data };
}

function valuesOf(result) {
  return Object.fromEntries(Object.entries(result.output.extracted_fields)
    .map(([key, field]) => [key, field.value]));
}

const inputText = [
  'ミナト医療機器です。見積をお願いします。',
  '品名: PPSカバー80',
  '品番: PPS-CVR-80',
  '数量: 200個',
  '材質: PPS',
  '寸法: 80×60×10mm',
  '公差: ±0.1mm',
  '希望納期: 2026-10-15'
].join('\n');

const extraction = await api('/api/extraction', {
  schema_version: 'extraction-1.0', customer_name: 'ミナト医療機器',
  received_at: '2026-09-06T12:00:00+09:00', request_channel: 'email',
  case_type: '規格品', item_scope: 'single', request_text: inputText, mode: 'local', consent: false
});
const review = await api(`/api/extraction/${extraction.output.audit_log_id}/review`, {
  revision: extraction.revision, values: valuesOf(extraction), acknowledged: true
});
let search = await api(`/api/extraction/${review.output.audit_log_id}/similar-search`, {
  revision: review.revision, values: { ...valuesOf(review), process_type: null }, acknowledged: true
});
const customer = search.entity_candidates.customers[0];
const product = search.entity_candidates.products[0];
assert.ok(customer && product);
const suggestion = await api(`/api/similar-search/${search.run_id}/process-types`, {
  revision: search.revision, customer_candidate_id: customer.candidate_id, product_candidate_id: product.candidate_id
});
assert.equal(suggestion.suggestion.master.available, false);
assert.equal(suggestion.suggestion.status, 'multiple_candidates');
assert.ok(suggestion.suggestion.candidates.length >= 2);

const rejectedSalesChoice = await apiError(`/api/similar-search/${search.run_id}/quotes`, {
  revision: search.revision, customer_candidate_id: customer.candidate_id, product_candidate_id: product.candidate_id,
  process_type_decision: {
    source: 'past_history', value: suggestion.suggestion.candidates[0].process_type, confirmed: true,
    confirmed_by: '営業担当（テスト）', basis: '複数候補の先頭を営業判断だけで選ぼうとした。'
  }
});
assert.equal(rejectedSalesChoice.status, 400);
assert.equal(rejectedSalesChoice.code, 'PROCESS_TYPE_HISTORY_INVALID');

search = await api(`/api/similar-search/${search.run_id}/quotes`, {
  revision: search.revision, customer_candidate_id: customer.candidate_id, product_candidate_id: product.candidate_id,
  process_type_decision: {
    source: 'technical_required', value: null, confirmed: false,
    confirmed_by: '営業担当（テスト）',
    basis: '同一顧客・品番・材質・数量の履歴に複数加工種別があるため、技術担当へ確認する。'
  }
});
assert.equal(search.similar_quotes.length, 0);
assert.equal(search.price_analysis.status, 'not_executed_process_type');
assert.equal(search.price_analysis.adoption_blocked, true);
search = await api(`/api/similar-search/${search.run_id}/decision`, {
  revision: search.revision, quote_id: null, decision: 'rejected',
  reason: '加工種別が未確定のため過去価格を採用せず、技術担当の回答後に再検索する。'
});
const heldApproval = await api(`/api/extraction/${review.output.audit_log_id}/approval-email`, {
  planned_price: 100000, cost: 70000, list_price: 100000,
  required_tech_review: false, required_supplier_quote: false, route_basis: '', acknowledged: true
});
assert.equal(heldApproval.approval.status, 'hold');
assert.deepEqual(heldApproval.approval.approver_roles, ['技術担当']);
assert.ok(heldApproval.approval.rule_results.some(rule => rule.rule_id === 'PROCESS-001' && rule.outcome === 'hold'));

search = await api(`/api/similar-search/${search.run_id}/quotes`, {
  revision: search.revision, customer_candidate_id: customer.candidate_id, product_candidate_id: product.candidate_id,
  process_type_decision: {
    source: 'technical_confirmed', value: '板金', confirmed: true,
    confirmed_by: '技術担当（架空テスト回答）',
    basis: '課題用の架空回答。図面と工程を確認し、本テストでは加工種別を板金と確定したものとして再開する。'
  }
});
assert.equal(search.decision, null);
assert.equal(search.process_type_decision.source, 'technical_confirmed');
assert.equal(search.input.process_type, '板金');
assert.ok(search.similar_quotes.length > 0);
assert.equal(search.price_analysis.adoption_blocked, false);
search = await api(`/api/similar-search/${search.run_id}/decision`, {
  revision: search.revision, quote_id: search.similar_quotes[0].quote_id, decision: 'accepted',
  reason: '技術担当の架空回答で加工種別を確定後、比較条件と注記を確認して参考案件として採用する。'
});
const resumedApproval = await api(`/api/extraction/${review.output.audit_log_id}/approval-email`, {
  planned_price: 100000, cost: 70000, list_price: 100000,
  required_tech_review: false, required_supplier_quote: false, route_basis: '', acknowledged: true
});
assert.equal(resumedApproval.approval.status, 'not_required');
assert.ok(!resumedApproval.approval.rule_results.some(rule => rule.rule_id === 'PROCESS-001'));

const report = {
  report_version: 'process-type-routing-1.0', executed_at: new Date().toISOString(), result: '合格',
  source_limit: '現行20_商品マスタに加工種別列はないため、商品マスタ自動確定は未利用。',
  suggestion: suggestion.suggestion,
  controls: {
    sales_choice_from_multiple_candidates_rejected: rejectedSalesChoice,
    price_comparison_not_executed_before_confirmation: search.price_analysis,
    held_approval_status: heldApproval.approval.status,
    held_approver_roles: heldApproval.approval.approver_roles,
    process_rule: heldApproval.approval.rule_results.find(rule => rule.rule_id === 'PROCESS-001'),
    resumed_after_fictional_technical_answer: {
      process_type: search.process_type_decision.value,
      process_type_source: search.process_type_decision.source,
      previous_quote_decision_cleared_before_reselection: true,
      similar_quote_count: search.similar_quotes.length,
      price_status: search.price_analysis.status,
      new_quote_decision: search.decision,
      approval_status: resumedApproval.approval.status,
      note: '技術担当の回答は課題用の架空回答であり、原本CSVの事実ではない。'
    },
    external_ai_calls: 0,
    final_decision_by_ai: false
  },
  records: { extraction_id: extraction.output.audit_log_id, search_run_id: search.run_id,
    held_approval_run_id: heldApproval.run_id, resumed_approval_run_id: resumedApproval.run_id }
};
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputUrl.pathname, result: report.result,
  suggestion_status: suggestion.suggestion.status,
  candidate_count: suggestion.suggestion.candidates.length,
  sales_override_error: rejectedSalesChoice.code,
  price_status: search.price_analysis.status,
  held_approval_status: heldApproval.approval.status,
  held_approver_roles: heldApproval.approval.approver_roles,
  resumed_process_type: search.process_type_decision.value,
  resumed_similar_quote_count: search.similar_quotes.length,
  resumed_approval_status: resumedApproval.approval.status }, null, 2));
