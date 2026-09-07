import { writeFile } from 'node:fs/promises';

const baseUrl = process.env.MVP_BASE_URL || 'http://127.0.0.1:4173';
const outputUrl = new URL('../docs/chapter8-normal-comparable-result-2026-09-06.json', import.meta.url);

async function api(path, body) {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${data.error || 'API error'}`);
  return data;
}

function valuesOf(result) {
  return Object.fromEntries(Object.entries(result.output.extracted_fields)
    .map(([key, field]) => [key, field.value]));
}

const testCase = {
  id: 'N-COMP-01',
  name: '過去実績の加工種別候補を営業が確認する正常ケース',
  source_basis: {
    file: 'data/raw/18_過去見積履歴.csv',
    comparable_quotes: ['Q-250708-0699', 'Q-250417-1842'],
    customer_name: '京浜ロボティクス株式会社 埼玉工場',
    product_code: 'S45C-PIN-18',
    product_name: 'S45Cピン18',
    material: 'S45C',
    quantity: 100,
    process_type: '樹脂切削'
  },
  input_text: [
    '京浜ロボティクス株式会社 埼玉工場です。見積をお願いします。',
    '品名: S45Cピン18',
    '品番: S45C-PIN-18',
    '数量: 100個',
    '材質: S45C',
    '寸法: φ18×80mm',
    '公差: ±0.05mm',
    '希望納期: 2026-10-15'
  ].join('\n'),
  approval_input: {
    planned_price: 100000,
    cost: 70000,
    list_price: 100000,
    required_tech_review: false,
    required_supplier_quote: false
  }
};

const health = await api('/api/health');
const extraction = await api('/api/extraction', {
  schema_version: 'extraction-1.0',
  customer_name: testCase.source_basis.customer_name,
  received_at: '2026-09-06T17:30:00+09:00',
  request_channel: 'email',
  case_type: '規格品',
  item_scope: 'single',
  request_text: testCase.input_text,
  mode: 'local',
  consent: false
});
const review = await api(`/api/extraction/${extraction.output.audit_log_id}/review`, {
  revision: extraction.revision,
  values: valuesOf(extraction),
  acknowledged: true
});
const search = await api(`/api/extraction/${review.output.audit_log_id}/similar-search`, {
  revision: review.revision,
  values: { ...valuesOf(review), process_type: null },
  acknowledged: true
});
const customer = search.entity_candidates.customers[0];
const product = search.entity_candidates.products[0];
if (!customer || !product) throw new Error('比較テストに必要な顧客・商品候補がありません。');
const processSuggestion = await api(`/api/similar-search/${search.run_id}/process-types`, {
  revision: search.revision, customer_candidate_id: customer.candidate_id,
  product_candidate_id: product.candidate_id
});
if (processSuggestion.suggestion.status !== 'single_candidate')
  throw new Error(`加工種別が一意な候補になりません：${processSuggestion.suggestion.status}`);
const processCandidate = processSuggestion.suggestion.candidates[0];
let quotes = await api(`/api/similar-search/${search.run_id}/quotes`, {
  revision: search.revision,
  customer_candidate_id: customer.candidate_id,
  product_candidate_id: product.candidate_id,
  process_type_decision: { source: 'past_history', value: processCandidate.process_type, confirmed: true,
    confirmed_by: '営業担当（テスト）',
    basis: `同一条件の過去実績${processCandidate.count}件がすべて同じ加工種別。参照：${processCandidate.quote_ids.join('、')}` }
});
const selectedQuoteId = quotes.similar_quotes[0]?.quote_id;
if (!selectedQuoteId) throw new Error('採否を記録する類似見積候補がありません。');
quotes = await api(`/api/similar-search/${quotes.run_id}/decision`, {
  revision: quotes.revision,
  quote_id: selectedQuoteId,
  decision: 'accepted',
  reason: '比較可能条件と価格差警告を確認した。価格は確定せず、見積回答予告の下書き作成にのみ使用する。'
});
const approval = await api(`/api/extraction/${review.output.audit_log_id}/approval-email`, {
  ...testCase.approval_input,
  route_basis: '',
  acknowledged: true
});
const draft = await api(`/api/approval-email/${approval.run_id}/drafts`, {
  draft_type: 'quote_notice',
  recipient_role: '顧客担当者',
  missing_items: [],
  questions: [],
  customer_reference: '比較可能正常ケース N-COMP-01',
  sender_name: '営業担当（テスト）',
  mode: 'local',
  consent: false
});
const reviewedDraft = await api(`/api/approval-email/${approval.run_id}/drafts/${draft.draft_id}/review`, {
  subject: draft.draft.subject,
  body: draft.draft.body,
  decision: 'adopted',
  reason: '価格断定・納期確約がなく、顧客向けの見積回答予告として利用可能なため。',
  reviewer: '営業担当（テスト）'
});

const actualQuoteIds = quotes.similar_quotes.map(row => row.quote_id);
const checks = [
  { name: 'UI・バックエンド・DBが正常', passed: health.ui.ok && health.backend.ok && health.database.ok,
    evidence: health },
  { name: '抽出項目に不足がない', passed: review.output.missing_fields.length === 0,
    evidence: review.output.missing_fields.map(row => row.field_name) },
  { name: '確定後の加工種別だけが検索条件に入った', passed: quotes.input.process_type === testCase.source_basis.process_type,
    evidence: quotes.input.process_type },
  { name: '過去実績から一意な候補を提示し営業確認を記録した',
    passed: processSuggestion.suggestion.status === 'single_candidate'
      && quotes.process_type_decision?.source === 'past_history' && quotes.process_type_decision?.confirmed === true,
    evidence: { suggestion: processSuggestion.suggestion, decision: quotes.process_type_decision } },
  { name: '比較可能な過去見積が2件以上ある', passed: quotes.price_analysis.comparable_count >= 2,
    evidence: { comparable_count: quotes.price_analysis.comparable_count, quote_ids: actualQuoteIds } },
  { name: '想定した過去見積2件を含む', passed: testCase.source_basis.comparable_quotes.every(id => actualQuoteIds.includes(id)),
    evidence: actualQuoteIds },
  { name: '価格比較で停止されない', passed: quotes.price_analysis.adoption_blocked === false && quotes.price_analysis.severity !== 'stop',
    evidence: { status: quotes.price_analysis.status, severity: quotes.price_analysis.severity,
      message: quotes.price_analysis.message } },
  { name: '承認不要となる', passed: approval.approval.status === 'not_required' && approval.approval.approver_roles.length === 0,
    evidence: { status: approval.approval.status, approver_roles: approval.approval.approver_roles,
      gross_margin_rate: approval.approval.calculated_values.gross_margin_rate,
      discount_rate: approval.approval.calculated_values.discount_rate } },
  { name: '見積回答予告の下書きを作成できる', passed: draft.draft_type === 'quote_notice' && draft.quality.passed,
    evidence: { draft_type: draft.draft_type, quality: draft.quality, subject: draft.draft.subject } },
  { name: '人間の採用記録まで保存できる', passed: reviewedDraft.status === 'adopted' && reviewedDraft.human_review?.decision === 'adopted',
    evidence: { status: reviewedDraft.status, human_review: reviewedDraft.human_review } },
  { name: '外部AI送信・自動送信がない', passed: extraction.execution.external_attempts === 0
      && search.security.external_ai_calls === 0 && approval.security.auto_send === false
      && draft.security.auto_send === false && draft.security.send_endpoint === false,
    evidence: { extraction_external_attempts: extraction.execution.external_attempts,
      search_external_ai_calls: search.security.external_ai_calls,
      approval_auto_send: approval.security.auto_send, draft_auto_send: draft.security.auto_send,
      draft_send_endpoint: draft.security.send_endpoint } }
];
const failed = checks.filter(check => !check.passed);
const report = {
  report_version: 'chapter8-normal-comparable-1.0',
  executed_at: new Date().toISOString(),
  test_case: testCase,
  result: failed.length ? '不合格' : '合格',
  checks,
  workflow: {
    extraction_audit_log_id: extraction.output.audit_log_id,
    search_run_id: quotes.run_id,
    selected_customer: { id: customer.candidate_id, name: customer.customer_name },
    selected_product: { id: product.candidate_id, logical_key: product.logical_key },
    process_type_suggestion: processSuggestion.suggestion,
    price_analysis: quotes.price_analysis,
    selected_quote_id: selectedQuoteId,
    approval_run_id: approval.run_id,
    approval: approval.approval,
    draft_id: draft.draft_id,
    draft: draft.draft,
    draft_quality: draft.quality,
    draft_review: reviewedDraft.human_review,
    security: { external_ai_sent: false, auto_send: false }
  }
};

await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputUrl.pathname, result: report.result,
  failed: failed.map(row => row.name), comparable_count: quotes.price_analysis.comparable_count,
  price_severity: quotes.price_analysis.severity, approval_status: approval.approval.status,
  draft_type: draft.draft_type, draft_status: reviewedDraft.status,
  auto_send: draft.security.auto_send }, null, 2));
