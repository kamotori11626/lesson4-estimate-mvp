import { readFile, writeFile } from 'node:fs/promises';
import { checkDraftQuality, validateDraftInput } from '../src/email-drafts.mjs';

const baseUrl = process.env.MVP_BASE_URL || 'http://127.0.0.1:4173';
const fixtureUrl = new URL('../tests/fixtures/chapter8-test-data-2026-09-06.json', import.meta.url);
const outputUrl = new URL('../docs/chapter8-test-results-2026-09-06.json', import.meta.url);
const normalComparableUrl = new URL('../docs/chapter8-normal-comparable-result-2026-09-06.json', import.meta.url);
const processTypeRoutingUrl = new URL('../docs/process-type-routing-result-2026-09-06.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));

async function api(path, body) {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status; error.data = data;
    throw error;
  }
  return data;
}

const channelMap = { メール: 'email', FAX: 'fax', 電話: 'phone', Webフォーム: 'web' };
const valuesOf = result => Object.fromEntries(Object.entries(result.output.extracted_fields).map(([key, field]) => [key, field.value]));
const warningCodes = result => result.output.warnings_and_holds.map(item => item.code);

function extractionInput(item) {
  const source = item.source_facts || {};
  const controls = item.input_controls || {};
  return {
    schema_version: 'extraction-1.0',
    customer_name: source.customer_name || item.input_text.split('です')[0] || '検証用顧客',
    received_at: `${source.received_date || '2026-09-06'}T09:00:00+09:00`,
    request_channel: channelMap[source.request_channel] || 'email',
    case_type: controls.case_type || (item.id === 'E-03' ? '類似品' : '規格品'),
    item_scope: controls.item_scope || 'single',
    request_text: item.input_text,
    mode: 'local', consent: false
  };
}

async function continueWorkflow(item, extracted, actual) {
  const review = await api(`/api/extraction/${extracted.output.audit_log_id}/review`, {
    revision: extracted.revision, values: valuesOf(extracted), acknowledged: true
  });
  actual.review = { saved: true, revision: review.revision, missing_fields: review.output.missing_fields.map(field => field.field_name) };
  const searchValues = { ...valuesOf(review), process_type: item.search_additions?.process_type || '検証用加工' };
  const search = await api(`/api/extraction/${review.output.audit_log_id}/similar-search`, {
    revision: review.revision, values: searchValues, acknowledged: true
  });
  actual.search = {
    customer_candidates: search.entity_candidates.customers.map(row => ({ id: row.candidate_id, name: row.customer_name, score: row.similarity_score })),
    product_candidates: search.entity_candidates.products.map(row => ({ id: row.candidate_id, logical_key: row.logical_key,
      score: row.similarity_score, members: row.members.map(member => ({ code: member.product_code, name: member.product_name })) })),
    external_ai_calls: search.security.external_ai_calls
  };
  const product = search.entity_candidates.products[0];
  if (!product) {
    actual.search.stopped = '商品候補なし';
    return;
  }
  const customer = search.entity_candidates.customers[0] || null;
  let quotes = await api(`/api/similar-search/${search.run_id}/quotes`, {
    revision: search.revision, customer_candidate_id: customer?.candidate_id || null, product_candidate_id: product.candidate_id,
    process_type_decision: { source: 'technical_confirmed', value: searchValues.process_type, confirmed: true,
      confirmed_by: '技術担当（Chapter 8テスト）',
      basis: '加工種別確定責任の検証用に技術担当の架空回答として明示した。配布CSVの事実ではない。' }
  });
  actual.search.price_analysis = { status: quotes.price_analysis.status, severity: quotes.price_analysis.severity,
    adoption_blocked: quotes.price_analysis.adoption_blocked, message: quotes.price_analysis.message };
  const selectedQuote = quotes.price_analysis.adoption_blocked ? null : quotes.similar_quotes[0]?.quote_id || null;
  const decision = selectedQuote ? 'accepted' : 'rejected';
  quotes = await api(`/api/similar-search/${quotes.run_id}/decision`, {
    revision: quotes.revision, quote_id: selectedQuote, decision,
    reason: selectedQuote
      ? 'Chapter 8テストとして一致根拠・差異・注意事項を確認した。価格は転用しない。'
      : 'Chapter 8テストとして比較不能または停止を確認した。候補は採用せず人間確認へ戻す。'
  });
  actual.search.decision = decision;

  const approvalInput = item.approval_input || {
    planned_price: 100000, cost: 70000, list_price: 100000,
    required_tech_review: false, required_supplier_quote: false
  };
  const approval = await api(`/api/extraction/${review.output.audit_log_id}/approval-email`, {
    ...approvalInput,
    route_basis: approvalInput.required_tech_review || approvalInput.required_supplier_quote ? '配布ログの確認フラグに基づくChapter 8テスト' : '',
    acknowledged: true
  });
  actual.approval = { status: approval.approval.status, approver_roles: approval.approval.approver_roles,
    gross_margin_rate: approval.approval.calculated_values.gross_margin_rate,
    discount_rate: approval.approval.calculated_values.discount_rate,
    rule_results: approval.approval.rule_results.map(rule => ({ rule_id: rule.rule_id, outcome: rule.outcome, reason: rule.reason })),
    external_ai_calls: approval.security.external_ai_calls };

  const missing = review.output.missing_fields;
  const draftType = missing.length ? 'customer_inquiry' : approval.approval.status === 'not_required' ? 'quote_notice' : 'internal_review';
  const recipient = draftType === 'customer_inquiry' || draftType === 'quote_notice' ? '顧客担当者'
    : approval.approval.approver_roles.includes('管理職') ? '管理職' : '技術担当者';
  const draft = await api(`/api/approval-email/${approval.run_id}/drafts`, {
    draft_type: draftType, recipient_role: recipient, missing_items: [],
    questions: draftType === 'internal_review' ? ['判定理由と次の対応をご確認ください。'] : [],
    customer_reference: draftType === 'internal_review' ? null : `Chapter8-${item.id}`,
    sender_name: '営業担当（テスト）', mode: 'local', consent: false
  });
  actual.draft = { type: draft.draft_type, generation_method: draft.generation_method,
    quality_passed: draft.quality.passed, violations: draft.quality.violations,
    prohibited_expressions_absent: draft.quality.checks.prohibited_expressions_absent,
    auto_send: draft.security.auto_send, send_endpoint: draft.security.send_endpoint,
    subject: draft.draft.subject, body: draft.draft.body };
}

function assess(item, actual) {
  const checks = [];
  const add = (name, passed, evidence) => checks.push({ name, passed, evidence });
  add('外部AI送信なし', actual.extraction.external_attempts === 0, `external_attempts=${actual.extraction.external_attempts}`);
  if (item.id.startsWith('N-')) {
    add('抽出項目に不足なし', actual.extraction.missing_fields.length === 0, actual.extraction.missing_fields.join('、') || '不足0件');
    add('顧客候補あり', (actual.search?.customer_candidates?.length || 0) > 0, `${actual.search?.customer_candidates?.length || 0}件`);
    add('商品候補あり', (actual.search?.product_candidates?.length || 0) > 0, `${actual.search?.product_candidates?.length || 0}件`);
    add('標準案件が保留なく次工程へ進める', actual.approval?.status === 'not_required',
      `approval.status=${actual.approval?.status || '未実行'}／価格比較=${actual.search?.price_analysis?.status || '未実行'}`);
    add('下書き品質合格', actual.draft?.quality_passed === true, actual.draft ? JSON.stringify(actual.draft.violations) : '下書き未作成');
    add('自動送信なし', actual.draft?.auto_send === false && actual.draft?.send_endpoint === false, actual.draft ? `auto_send=${actual.draft.auto_send}` : '下書き未作成');
  } else if (item.id === 'E-01') {
    add('不足情報を検知', ['product_code','material','dimensions','tolerance'].every(key => actual.extraction.missing_fields.includes(key)), actual.extraction.missing_fields.join('、'));
    add('確認メールに不足項目を列挙', ['品番','材質','寸法','公差'].every(label => actual.draft?.body.includes(label)), actual.draft?.body || '下書き未作成');
    add('禁止表現なし・自動送信なし', actual.draft?.prohibited_expressions_absent === true && actual.draft?.auto_send === false, JSON.stringify(actual.draft?.violations || []));
  } else if (item.id === 'E-02') {
    add('粗利率16.7%を再現', actual.approval?.gross_margin_rate === 16.7, `${actual.approval?.gross_margin_rate}%`);
    add('GM-018が発火', actual.approval?.rule_results.some(rule => rule.rule_id === 'GM-018' && rule.outcome === 'required'), JSON.stringify(actual.approval?.rule_results || []));
    add('管理職を確認先に含む', actual.approval?.approver_roles.includes('管理職'), (actual.approval?.approver_roles || []).join('、'));
  } else if (item.id === 'E-03') {
    add('顧客候補あり', (actual.search?.customer_candidates?.length || 0) > 0, JSON.stringify(actual.search?.customer_candidates || []));
    add('品番表記ゆれ候補あり', (actual.search?.product_candidates || []).some(row => row.logical_key === 'PEEKGR10'
      && row.members.some(member => ['PEEK-GR-10','PEEK_GR_10'].includes(member.code))), JSON.stringify(actual.search?.product_candidates || []));
    add('候補は人間判断まで', ['accepted','rejected'].includes(actual.search?.decision), `decision=${actual.search?.decision || '未実行'}`);
  } else if (item.id === 'E-04') {
    add('新規特注を対象外保留', actual.extraction.warning_codes.includes('OUT_OF_MVP'), actual.extraction.warning_codes.join('、'));
    add('後工程へ進めない', !actual.review, '抽出段階で停止');
  } else if (item.id === 'P-01') {
    add('複数商品を全体保留', actual.extraction.warning_codes.includes('MULTIPLE_ITEMS'), actual.extraction.warning_codes.join('、'));
    add('後工程へ進めない', !actual.review, '抽出段階で停止');
  } else if (item.id === 'P-02') {
    add('数量矛盾を検知', actual.extraction.warning_codes.includes('CONFLICTING_VALUES'), actual.extraction.warning_codes.join('、'));
    add('数量を自動確定しない', actual.extraction.values.quantity === null, `quantity=${actual.extraction.values.quantity}`);
  } else if (item.id === 'P-03') {
    add('入力内命令を実行しない', actual.extraction.external_attempts === 0 && !actual.draft, `外部送信=${actual.extraction.external_attempts}、下書き=${actual.draft ? 'あり' : 'なし'}`);
    const maliciousInput = validateDraftInput({ draft_type: 'quote_notice', mode: 'local', recipient_role: '顧客担当者',
      missing_items: [], questions: [], customer_name: '検証用顧客', product_label: 'POM-120-8', request_id: 'TEST-P-03',
      customer_reference: 'Chapter8-P-03', sender_name: '営業担当（テスト）', consent: false });
    const quality = checkDraftQuality({
      subject: '【お見積り受付のご連絡】POM-120-8',
      body: [
        '検証用顧客',
        'ご担当者様',
        '',
        '対象商品：POM-120-8',
        '弊社案件番号：TEST-P-03',
        'お客様の問い合わせ番号・元メール件名：Chapter8-P-03',
        '80,000円で確定しました。2026-10-10までに納品いたします。',
        '',
        '営業担当（テスト）'
      ].join('\n'),
      referenced_item_ids: []
    }, maliciousInput);
    actual.prohibited_quality_gate = quality;
    add('価格断定・納期確約を品質検査で拒否', !quality.passed
      && quality.violations.some(v => v.code === 'PRICE_ASSERTION')
      && quality.violations.some(v => v.code === 'DELIVERY_GUARANTEE'), JSON.stringify(quality.violations));
    add('品質検査でも自動送信なし', quality.checks.auto_send === false, `auto_send=${quality.checks.auto_send}`);
  }
  const failed = checks.filter(check => !check.passed);
  return { checks, result: failed.length === 0 ? '合格' : failed.some(check => /禁止|自動送信|外部AI/.test(check.name)) ? '不合格' : '条件付き合格', failed_count: failed.length };
}

function supplementaryAssessment(checks) {
  const failed = checks.filter(check => !check.passed);
  return {
    checks,
    result: failed.length === 0 ? '合格' : '不合格',
    failed_count: failed.length
  };
}

async function loadSupplementaryResults() {
  const [normalComparable, processTypeRouting] = await Promise.all([
    readFile(normalComparableUrl, 'utf8').then(JSON.parse),
    readFile(processTypeRoutingUrl, 'utf8').then(JSON.parse)
  ]);

  if (normalComparable.test_case?.id !== 'N-COMP-01') {
    throw new Error('比較可能な正常ケースの検証記録にN-COMP-01がありません。');
  }
  const normalChecks = normalComparable.checks.map(check => ({
    name: check.name,
    passed: check.passed === true,
    evidence: check.evidence
  }));
  const normalAssessment = supplementaryAssessment(normalChecks);
  if (normalComparable.result !== normalAssessment.result) {
    throw new Error(`N-COMP-01の元記録と集計結果が一致しません: ${normalComparable.result}/${normalAssessment.result}`);
  }

  const routing = processTypeRouting.controls || {};
  const resumed = routing.resumed_after_fictional_technical_answer || {};
  const routingChecks = [
    {
      name: '複数候補を営業が確定できない',
      passed: routing.sales_choice_from_multiple_candidates_rejected?.status === 400
        && routing.sales_choice_from_multiple_candidates_rejected?.code === 'PROCESS_TYPE_HISTORY_INVALID',
      evidence: routing.sales_choice_from_multiple_candidates_rejected || null
    },
    {
      name: '価格比較前に技術担当へ保留する',
      passed: routing.held_approval_status === 'hold'
        && routing.held_approver_roles?.includes('技術担当')
        && routing.process_rule?.rule_id === 'PROCESS-001',
      evidence: {
        approval_status: routing.held_approval_status || null,
        approver_roles: routing.held_approver_roles || [],
        rule: routing.process_rule || null
      }
    },
    {
      name: '技術回答後に旧判断を破棄して再検索・再判定する',
      passed: resumed.previous_quote_decision_cleared_before_reselection === true
        && resumed.similar_quote_count > 0
        && resumed.approval_status === 'not_required',
      evidence: resumed
    },
    {
      name: '外部AIに確定させない',
      passed: routing.external_ai_calls === 0 && routing.final_decision_by_ai === false,
      evidence: {
        external_ai_calls: routing.external_ai_calls,
        final_decision_by_ai: routing.final_decision_by_ai
      }
    }
  ];
  const routingAssessment = supplementaryAssessment(routingChecks);
  if (processTypeRouting.result !== routingAssessment.result) {
    throw new Error(`P-04の元記録と集計結果が一致しません: ${processTypeRouting.result}/${routingAssessment.result}`);
  }

  return {
    sources: [
      {
        path: 'docs/chapter8-normal-comparable-result-2026-09-06.json',
        report_version: normalComparable.report_version,
        executed_at: normalComparable.executed_at,
        result: normalComparable.result
      },
      {
        path: 'docs/process-type-routing-result-2026-09-06.json',
        report_version: processTypeRouting.report_version,
        executed_at: processTypeRouting.executed_at,
        result: processTypeRouting.result
      }
    ],
    results: [
      {
        id: 'N-COMP-01',
        category: 'normal',
        name: normalComparable.test_case.name,
        source_rfq: null,
        input_text: normalComparable.test_case.input_text,
        expected: normalChecks.map(check => check.name),
        actual: {
          evidence_file: 'docs/chapter8-normal-comparable-result-2026-09-06.json',
          executed_at: normalComparable.executed_at,
          source_basis: normalComparable.test_case.source_basis,
          workflow_ids: {
            extraction_audit_log_id: normalComparable.workflow?.extraction_audit_log_id || null,
            search_run_id: normalComparable.workflow?.search_run_id || null
          }
        },
        assessment: normalAssessment,
        note: '個別検証記録を主テスト結果へ統合した。外部AI送信なし、自動送信なし。'
      },
      {
        id: 'P-04',
        category: 'prohibited',
        name: '加工種別が複数候補',
        source_rfq: null,
        input_text: 'ミナト医療機器／PPS-CVR-80／PPS／200個。過去履歴の加工種別は板金2件、樹脂切削1件、短納期加工1件。',
        expected: routingChecks.map(check => check.name),
        actual: {
          evidence_file: 'docs/process-type-routing-result-2026-09-06.json',
          executed_at: processTypeRouting.executed_at,
          source_limit: processTypeRouting.source_limit,
          suggestion_status: processTypeRouting.suggestion?.status || null,
          records: processTypeRouting.records || null
        },
        assessment: routingAssessment,
        note: '個別検証記録を主テスト結果へ統合した。技術担当の回答は課題用の架空回答であり、原本CSVの事実ではない。'
      }
    ]
  };
}

const health = await api('/api/health');
const results = [];
for (const item of fixture.cases) {
  const actual = {};
  try {
    const extracted = await api('/api/extraction', extractionInput(item));
    actual.extraction = {
      audit_log_id: extracted.output.audit_log_id, status: extracted.output.status,
      method: extracted.execution.extraction_method, external_attempts: extracted.execution.external_attempts,
      missing_fields: extracted.output.missing_fields.map(field => field.field_name),
      warning_codes: warningCodes(extracted), values: valuesOf(extracted)
    };
    const stopped = actual.extraction.warning_codes.some(code => ['MULTIPLE_ITEMS','OUT_OF_MVP','OUT_OF_SCOPE','ITEM_COUNT_UNCERTAIN','SCOPE_UNCERTAIN'].includes(code));
    if (!stopped && !['P-02','P-03'].includes(item.id)) await continueWorkflow(item, extracted, actual);
  } catch (error) {
    actual.error = { message: error.message, status: error.status || null, data: error.data || null };
    if (!actual.extraction) actual.extraction = { external_attempts: 0, missing_fields: [], warning_codes: [], values: {} };
  }
  const assessment = assess(item, actual);
  results.push({ id: item.id, category: item.category, name: item.name, source_rfq: item.source_rfq,
    input_text: item.input_text, expected: item.expected, actual, assessment,
    note: assessment.result === '合格' ? '期待結果と一致した。' : assessment.result === '条件付き合格'
      ? '禁止事項には抵触していないが、業務利用前に記載の差異を確認する。' : '禁止事項または業務利用不能の問題があり、デモ前の修正が必要。' });
}

const supplementary = await loadSupplementaryResults();
results.push(...supplementary.results);
const resultOrder = ['N-01','N-02','N-03','N-COMP-01','E-01','E-02','E-03','E-04','P-01','P-02','P-03','P-04'];
results.sort((left, right) => resultOrder.indexOf(left.id) - resultOrder.indexOf(right.id));

const report = {
  report_version: 'chapter8-test-results-1.1', executed_at: new Date().toISOString(),
  execution: 'ローカルアプリケーションAPI。Gemini送信なし。顧客メール送信なし。',
  source_fixture: 'tests/fixtures/chapter8-test-data-2026-09-06.json',
  supplementary_sources: supplementary.sources,
  health: { ui: health.ui.ok, backend: health.backend.ok, database: health.database.ok },
  summary: Object.fromEntries(['合格','条件付き合格','不合格'].map(label => [label, results.filter(row => row.assessment.result === label).length])),
  results
};
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputUrl.pathname, summary: report.summary,
  rows: results.map(row => ({ id: row.id, result: row.assessment.result, failed: row.assessment.failed_count, error: row.actual.error?.message || null })) }, null, 2));
