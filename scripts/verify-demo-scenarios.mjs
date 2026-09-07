import assert from 'node:assert/strict';

const baseUrl = process.env.MVP_BASE_URL || 'http://127.0.0.1:4173';
const origin = new URL(baseUrl).origin;
let cookie = '';

async function api(path, body) {
  const options = body === undefined ? { headers: cookie ? { cookie } : {} } : {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body)
  };
  const response = await fetch(`${baseUrl}${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error || `HTTP ${response.status}`}`);
  return data;
}

async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username: process.env.MVP_USERNAME, password: process.env.MVP_PASSWORD }) });
  if (!response.ok) throw new Error('デモ検証用ログインに失敗しました。');
  cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
  assert.ok(cookie, '認証Cookieが必要');
}

const completeFields = Object.freeze({
  customer_name: 'アサヒ食品機械', product_name: '樹脂ローラー120', product_code: 'POM-120-8',
  quantity: 100, quantity_unit: '個', material: 'POM', dimensions: 'φ120×50mm',
  tolerance: '±0.1mm', requested_delivery_date: '2026-10-15'
});
const completeText = ['アサヒ食品機械です。見積をお願いします。', '品名: 樹脂ローラー120', '品番: POM-120-8',
  '数量: 100個', '材質: POM', '寸法: φ120×50mm', '公差: ±0.1mm', '希望納期: 2026-10-15'].join('\n');

const scenarios = [
  {
    id: 'normal', label: '正常ケース',
    input: { customer_name: 'アサヒ食品機械', received_at: '2026-09-03T09:00:00+09:00',
      request_channel: 'email', case_type: '規格品', item_scope: 'single', request_text: completeText },
    reviewValues: completeFields, searchValues: { ...completeFields, process_type: '複合加工' },
    searchDecision: 'accepted',
    approval: { planned_price: 100000, cost: 70000, list_price: 100000,
      required_tech_review: false, required_supplier_quote: false, route_basis: '' },
    expectedApproval: 'not_required',
    draft: { draft_type: 'quote_notice', recipient_role: '顧客担当者', customer_reference: 'デモ-N-001',
      sender_name: '営業一課 デモ担当', questions: [] }, expectedMissing: []
  },
  {
    id: 'missing', label: '例外ケース：不足情報',
    input: { customer_name: '検証用顧客B', received_at: '2026-09-03T09:10:00+09:00',
      request_channel: 'email', case_type: '類似品', item_scope: 'single',
      request_text: ['検証用顧客Bです。次の商品の見積をお願いします。', '品名: PPSカバー80',
        '数量: 1個', '公差: 不明', '希望納期: 2026-10-20'].join('\n') },
    reviewValues: { customer_name: '検証用顧客B', product_name: 'PPSカバー80', product_code: null,
      quantity: 1, quantity_unit: '個', material: null, dimensions: null, tolerance: null,
      requested_delivery_date: '2026-10-20' },
    searchValues: { customer_name: '検証用顧客B', product_name: 'PPSカバー80', product_code: null,
      quantity: 1, quantity_unit: '個', material: null, process_type: null, dimensions: null,
      tolerance: null, requested_delivery_date: '2026-10-20' },
    searchDecision: 'rejected',
    approval: { planned_price: 100000, cost: 70000, list_price: 100000,
      required_tech_review: false, required_supplier_quote: false, route_basis: '' },
    expectedApproval: 'hold',
    draft: { draft_type: 'customer_inquiry', recipient_role: '顧客担当者', customer_reference: 'デモ-M-001',
      sender_name: '営業一課 デモ担当', questions: [] },
    expectedMissing: ['product_code', 'material', 'dimensions', 'tolerance']
  },
  {
    id: 'approval', label: '例外ケース：承認・技術確認',
    input: { customer_name: 'アサヒ食品機械', received_at: '2026-09-03T09:20:00+09:00',
      request_channel: 'email', case_type: '類似品', item_scope: 'single', request_text: completeText },
    reviewValues: completeFields, searchValues: { ...completeFields, process_type: '複合加工' },
    searchDecision: 'accepted',
    approval: { planned_price: 100000, cost: 85000, list_price: 100000, required_tech_review: true,
      required_supplier_quote: false, route_basis: '粗利率15%かつ図面公差の技術確認が必要なデモ条件' },
    expectedApproval: 'required',
    draft: { draft_type: 'internal_review', recipient_role: '技術担当者', customer_reference: null,
      sender_name: '営業一課 デモ担当', questions: ['図面公差の適用可否をご確認ください。', '粗利率15%案件の承認可否をご確認ください。'] },
    expectedMissing: []
  }
];

async function run(scenario) {
  const extracted = await api('/api/extraction', { schema_version: 'extraction-1.0', ...scenario.input, mode: 'local', consent: false });
  assert.equal(extracted.execution.external_attempts, 0);
  assert.equal(extracted.execution.extraction_method, 'local_baseline');
  assert.deepEqual(extracted.output.missing_fields.map(item => item.field_name).sort(), [...scenario.expectedMissing].sort());
  const reviewed = await api(`/api/extraction/${extracted.output.audit_log_id}/review`, {
    revision: extracted.revision, values: scenario.reviewValues, acknowledged: true
  });
  assert.deepEqual(reviewed.output.missing_fields.map(item => item.field_name).sort(), [...scenario.expectedMissing].sort());

  let search = await api(`/api/extraction/${extracted.output.audit_log_id}/similar-search`, {
    revision: reviewed.revision, values: scenario.searchValues, acknowledged: true
  });
  const product = search.entity_candidates.products[0];
  assert.ok(product, `${scenario.id}: 商品候補が必要`);
  const customer = search.entity_candidates.customers[0] || null;
  if (scenario.id !== 'missing') {
    assert.equal(customer?.similarity_score, 100);
    assert.equal(product.similarity_score, 100);
  }
  search = await api(`/api/similar-search/${search.run_id}/quotes`, {
    revision: search.revision, customer_candidate_id: customer?.candidate_id || null,
    product_candidate_id: product.candidate_id,
    process_type_decision: scenario.searchValues.process_type
      ? { source: 'technical_confirmed', value: scenario.searchValues.process_type, confirmed: true,
        confirmed_by: '技術担当（デモ）', basis: 'デモ用の架空技術確認として加工種別を確定した。' }
      : { source: 'technical_required', value: null, confirmed: false,
        confirmed_by: '営業担当（デモ）', basis: '材質等が不足して加工種別を確定できないため技術確認へ回す。' }
  });
  if (scenario.id !== 'missing') assert.ok(search.similar_quotes.length > 0, `${scenario.id}: 過去見積候補が必要`);
  if (scenario.id !== 'missing') {
    assert.equal(search.price_analysis.status, 'alert');
    assert.equal(search.price_analysis.severity, 'attention');
    assert.equal(search.price_analysis.adoption_blocked, false);
  } else {
    assert.equal(search.price_analysis.status, 'not_executed_process_type');
    assert.equal(search.price_analysis.adoption_blocked, true);
  }
  const quoteId = scenario.searchDecision === 'accepted' ? search.similar_quotes[0].quote_id : null;
  search = await api(`/api/similar-search/${search.run_id}/decision`, {
    revision: search.revision, quote_id: quoteId, decision: scenario.searchDecision,
    reason: scenario.searchDecision === 'accepted'
      ? '一致根拠・差異・材料高騰注記を確認し、参考案件として採用するデモ記録。価格は転用しない。'
      : '顧客・仕様・比較可能条件が不足しているため候補を採用せず、確認後に再検索する。'
  });
  assert.equal(search.status, 'reviewed');

  const approval = await api(`/api/extraction/${extracted.output.audit_log_id}/approval-email`, {
    ...scenario.approval, acknowledged: true
  });
  assert.equal(approval.approval.status, scenario.expectedApproval);
  if (scenario.id === 'approval') {
    assert.ok(approval.approval.rule_results.some(rule => rule.rule_id === 'GM-018' && rule.outcome === 'required'));
    assert.ok(approval.approval.rule_results.some(rule => rule.rule_id === 'ROUTE-TECH' && rule.outcome === 'required'));
  }
  const draft = await api(`/api/approval-email/${approval.run_id}/drafts`, {
    ...scenario.draft, missing_items: [], mode: 'local', consent: false
  });
  assert.equal(draft.generation_method, 'local_template');
  assert.equal(draft.quality.passed, true);
  assert.equal(draft.security.auto_send, false);
  assert.doesNotMatch(draft.draft.body, /円で(?:ご提供|販売|見積)|までに納品(?:いた|し)ます/u);
  if (scenario.id === 'normal') {
    assert.match(draft.draft.body, /デモ-N-001/u);
    assert.match(draft.draft.body, /正式な見積金額および納期については、社内確認の上、改めてご連絡いたします。/u);
  } else if (scenario.id === 'missing') {
    for (const label of ['品番', '材質', '寸法', '公差']) assert.match(draft.draft.body, new RegExp(label, 'u'));
    assert.match(draft.draft.body, /以下の項目をご確認のうえ、ご回答くださいますようお願いいたします。/u);
    assert.match(draft.draft.body, /ご回答内容を確認後、正式な見積金額および納期を改めてご連絡いたします。/u);
  } else {
    assert.match(draft.draft.body, /技術担当の方へ/u);
    assert.match(draft.draft.body, /図面公差の適用可否/u);
    assert.match(draft.draft.body, /粗利率15%案件の承認可否/u);
  }
  const reviewedDraft = await api(`/api/approval-email/${approval.run_id}/drafts/${draft.draft_id}/review`, {
    subject: draft.draft.subject, body: draft.draft.body, decision: 'adopted',
    reason: 'デモの期待結果と禁止表現を確認した。実送信は行わない。', reviewer: 'デモ検証者'
  });
  assert.equal(reviewedDraft.status, 'adopted');

  const reloadedExtraction = await api(`/api/extraction/${extracted.output.audit_log_id}`);
  assert.equal(reloadedExtraction.output.audit_log_id, extracted.output.audit_log_id);
  assert.equal(reloadedExtraction.revision, reviewed.revision);
  assert.deepEqual(reloadedExtraction.output.extracted_fields, reviewed.output.extracted_fields);

  const workflow = await api(`/api/workflow/${extracted.output.audit_log_id}`);
  assert.equal(workflow.status, 'review_completed');
  assert.ok(workflow.steps.every(step => step.status === 'completed'));
  assert.equal(workflow.security.external_ai_calls_in_workflow_orchestration, 0);
  assert.equal(workflow.security.auto_send, false);
  return { id: scenario.id, label: scenario.label, workflow_id: workflow.workflow_id, request_id: workflow.request_id,
    search_run_id: search.run_id, approval_run_id: approval.run_id, draft_id: draft.draft_id,
    missing_fields: workflow.results.extraction.missing_fields.map(item => item.field_name),
    search_price_status: search.price_analysis.status, search_price_severity: search.price_analysis.severity,
    approval_status: approval.approval.status,
    approval_rule_ids: approval.approval.rule_results.filter(rule => rule.outcome !== 'no_trigger').map(rule => rule.rule_id),
    draft_type: draft.draft_type, draft_quality_passed: draft.quality.passed,
    workflow_status: workflow.status, completed_steps: workflow.steps.filter(step => step.status === 'completed').length,
    external_ai_calls: 0, auto_send: false };
}

const startedAt = Date.now();
const health = await api('/api/health');
assert.equal(health.ok, true);
await login();
const results = [];
for (const scenario of scenarios) results.push(await run(scenario));
console.log(JSON.stringify({ checked_at: new Date().toISOString(), elapsed_ms: Date.now() - startedAt,
  execution: 'normal local application API; Gemini not used', scenarios: results }, null, 2));
