import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflow, WORKFLOW_SCHEMA_VERSION } from '../src/workflow.mjs';

const extractionId = '11111111-1111-4111-8111-111111111111';
const searchId = '22222222-2222-4222-8222-222222222222';
const approvalId = '33333333-3333-4333-8333-333333333333';
const draftId = '44444444-4444-4444-8444-444444444444';

function bundle(overrides = {}) {
  const extraction = { run_id: extractionId, request_id: '55555555-5555-4555-8555-555555555555',
    created_at: new Date('2026-09-03T00:00:00Z'), updated_at: new Date('2026-09-03T00:01:00Z'), revision: 2,
    input_payload: { customer_name: '統合テスト顧客', received_at: '2026-09-03T09:00:00+09:00',
      request_channel: 'email', case_type: '規格品', item_scope: 'single', request_text: '統合テスト用の依頼文' },
    output_payload: { status: 'needs_review', warnings_and_holds: [], missing_fields: [], extracted_fields: {
      customer_name: { value: '統合テスト顧客' }, product_code: { value: 'TEST-01' }, product_name: { value: 'テスト商品' },
      material: { value: 'POM' }, quantity: { value: 10 }, quantity_unit: { value: '個' }, process_type: { value: '樹脂切削' }
    } } };
  const search = { run_id: searchId, extraction_run_id: extractionId, extraction_revision: 2,
    status: 'reviewed', input_payload: { customer_name: '統合テスト顧客', product_code: 'TEST-01', product_name: 'テスト商品',
      material: 'POM', quantity: 10, quantity_unit: '個', process_type: '樹脂切削', dimensions: null, tolerance: null,
      requested_delivery_date: null }, selected_customer: { candidate_id: 'customer:test' },
    selected_product: { candidate_id: 'product:test' }, similar_quotes: [{ quote_id: 'Q-001', similarity_score: 90,
      match_basis: [{ field: 'product_code', reason: '一致' }], differences: [{ field: 'quantity', status: 'same' }],
      source_link: null, data_as_of: '2026-09-03T00:00:00Z' }],
    decision: { quote_id: 'Q-001', decision: 'accepted', reason: '条件が最も近い' } };
  const approval = { run_id: approvalId, extraction_run_id: extractionId, similar_search_run_id: searchId,
    status: 'not_required', rule_version: 'test-rules', approval_result: { extraction_revision: 2, status: 'not_required',
      rule_results: [{ rule_id: 'GM-020', outcome: 'no_trigger', reason: '20%以上' }] } };
  const drafts = [{ draft_id: draftId, run_id: approvalId, status: 'adopted', draft_type: 'quote_notice',
    generation_method: 'local_template', draft_payload: { subject: '見積回答のご案内', body: '正式見積は改めてご連絡します。' },
    quality_result: { passed: true }, human_review: { decision: 'adopted', reason: '原文と照合済み' },
    created_at: new Date('2026-09-03T00:05:00Z'), updated_at: new Date('2026-09-03T00:06:00Z') }];
  const events = { extraction: [
    { occurred_at: new Date('2026-09-03T00:00:00Z'), event_type: 'started', event_summary: { input_length: 11, input_hash: 'hash' } },
    { occurred_at: new Date('2026-09-03T00:01:00Z'), event_type: 'finished', event_summary: { status: 'needs_review' } },
    { occurred_at: new Date('2026-09-03T00:02:00Z'), event_type: 'review_draft_saved', event_summary: { changed_fields: [] } }
  ], similar_search: [
    { occurred_at: new Date('2026-09-03T00:03:00Z'), event_type: 'human_decision_saved', event_summary: { decision: 'accepted' } }
  ], approval_email: [
    { occurred_at: new Date('2026-09-03T00:04:00Z'), event_type: 'approval_evaluated', event_summary: { status: 'not_required' } }
  ] };
  return { extraction, search, approval, drafts, events, ...overrides };
}

test('完了した一連の処理について受け渡し・結果・保存ログを統合表示する', () => {
  const result = buildWorkflow(bundle());
  assert.equal(result.schema_version, WORKFLOW_SCHEMA_VERSION);
  assert.equal(result.status, 'review_completed');
  assert.ok(result.steps.every(item => item.status === 'completed'));
  assert.equal(result.handoffs.extraction_to_search.status, 'same_revision');
  assert.equal(result.handoffs.search_to_approval.status, 'linked');
  assert.equal(result.handoffs.approval_to_draft.status, 'linked');
  assert.equal(result.results.similar_search.top_similar_cases[0].quote_id, 'Q-001');
  assert.equal(result.results.approval.status, 'not_required');
  assert.equal(result.results.draft.subject, '見積回答のご案内');
  assert.ok(result.logs.some(item => item.event_type === 'draft_snapshot_saved' && item.summary.body));
  assert.equal(result.security.auto_send, false);
  assert.equal(result.input_summary.raw_text_in_workflow_response, false);
});

test('未照合の抽出結果では人間確認を次操作として示し、後工程を未着手にする', () => {
  const source = bundle({ search: null, approval: null, drafts: [] });
  source.extraction.revision = 1;
  const result = buildWorkflow(source);
  assert.equal(result.status, 'in_progress');
  assert.match(result.next_action.label, /原文と照合/);
  assert.equal(result.steps.find(item => item.id === 'extraction_review').status, 'current');
  assert.equal(result.steps.find(item => item.id === 'similar_search').status, 'pending');
});

test('抽出結果の更新前に行った検索は再利用せず、再検索を案内する', () => {
  const source = bundle({ approval: null, drafts: [] });
  source.extraction.revision = 3;
  const result = buildWorkflow(source);
  assert.equal(result.handoffs.extraction_to_search.status, 'older_reviewed_revision');
  assert.match(result.next_action.label, /最新の抽出値/);
  assert.equal(result.steps.find(item => item.id === 'similar_search').status, 'current');
  assert.equal(result.steps.find(item => item.id === 'approval').status, 'pending');
});

test('複数商品など抽出段階の停止条件では後工程に進めず、やり直し方法を示す', () => {
  const source = bundle({ search: null, approval: null, drafts: [] });
  source.extraction.output_payload.status = 'error';
  source.extraction.output_payload.warnings_and_holds = [{ code: 'MULTIPLE_ITEMS' }];
  const result = buildWorkflow(source);
  assert.equal(result.status, 'blocked');
  assert.match(result.next_action.label, /新しい依頼としてやり直/);
  assert.equal(result.steps.find(item => item.id === 'extraction').status, 'blocked');
});
