import { createHash } from 'node:crypto';
import { ExtractionError } from './extraction.mjs';

export const WORKFLOW_SCHEMA_VERSION = 'integrated-workflow-1.0';
const STOP_CODES = new Set(['MULTIPLE_ITEMS', 'OUT_OF_MVP', 'OUT_OF_SCOPE', 'ITEM_COUNT_UNCERTAIN', 'SCOPE_UNCERTAIN']);

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function fieldValues(extraction) {
  return Object.fromEntries(Object.entries(extraction.output_payload?.extracted_fields || {})
    .map(([key, value]) => [key, value?.value ?? null]));
}

function quoteSummary(quote) {
  return {
    quote_id: quote.quote_id,
    similarity_score: quote.similarity_score,
    match_basis: quote.match_basis,
    differences: quote.differences,
    source_link: quote.source_link,
    data_as_of: quote.data_as_of
  };
}

function latestDraft(drafts) {
  return drafts?.[0] || null;
}

function normalizedEvents(bundle) {
  const rows = [];
  for (const [source, events] of Object.entries(bundle.events || {})) {
    for (const event of events) rows.push({ source, occurred_at: iso(event.occurred_at),
      event_type: event.event_type, summary: event.event_summary });
  }
  const draft = latestDraft(bundle.drafts);
  if (draft) rows.push({ source: 'approval_email', occurred_at: iso(draft.updated_at || draft.created_at),
    event_type: 'draft_snapshot_saved', summary: {
      draft_id: draft.draft_id, draft_type: draft.draft_type, status: draft.status,
      subject: draft.subject || draft.draft_payload?.subject || null,
      body: draft.body || draft.draft_payload?.body || null,
      generation_method: draft.generation_method, quality_passed: draft.quality_result?.passed ?? false,
      auto_send: false
    } });
  return rows.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
}

function step(id, label, status, detail, target_id) {
  return { id, label, status, detail, target_id };
}

export function buildWorkflow(bundle) {
  const extraction = bundle.extraction;
  if (!extraction) throw new ExtractionError('NOT_FOUND', '対象の統合ワークフローがありません。', 404);
  const output = extraction.output_payload;
  const search = bundle.search;
  const approval = bundle.approval;
  const draft = latestDraft(bundle.drafts);
  const stopped = output.status === 'error' || (output.warnings_and_holds || []).some(item => STOP_CODES.has(item.code));
  const reviewed = extraction.revision > 1;
  const searchCurrent = Boolean(search && search.extraction_revision === extraction.revision);
  const searchReviewed = Boolean(searchCurrent && search.status === 'reviewed');
  const approvalCurrent = Boolean(approval && searchReviewed && approval.similar_search_run_id === search.run_id
    && approval.approval_result?.extraction_revision === extraction.revision);
  const draftReviewed = ['adopted', 'rejected'].includes(draft?.status);
  const draftCurrent = Boolean(approvalCurrent && draft && draft.run_id === approval.run_id);
  const workflowComplete = Boolean(draftCurrent && draftReviewed);

  const steps = [
    step('input', '見積依頼を入力', 'completed', `${extraction.input_payload?.request_channel || '経路不明'}・${extraction.input_payload?.case_type || '種別不明'}`, 'extraction-title'),
    step('extraction', '情報を抽出', stopped ? 'blocked' : 'completed', `状態 ${output.status}／不足 ${(output.missing_fields || []).length}件`, 'extraction-title'),
    step('extraction_review', '人間が原文照合', stopped ? 'blocked' : reviewed ? 'completed' : 'current', reviewed ? `修正下書き保存済み（版${extraction.revision}）` : '原文照合と修正下書きの保存が必要', 'ex-fields'),
    step('similar_search', '名寄せ・類似案件を確認', !reviewed || stopped ? 'pending' : !search || !searchCurrent || !searchReviewed ? 'current' : 'completed',
      search ? `${searchCurrent ? '' : '抽出結果更新前の記録・再検索必要／'}状態 ${search.status}／過去見積 ${(search.similar_quotes || []).length}件` : '未実行', 'similar-search-panel'),
    step('approval', '承認要否を判定', !searchReviewed ? 'pending' : !approvalCurrent ? 'current' : 'completed',
      approval ? `${approvalCurrent ? '' : '最新検索との再連携必要／'}判定 ${approval.status}` : '未実行', 'approval-email-panel'),
    step('draft', '文面下書きを作成', !approvalCurrent ? 'pending' : !draftCurrent ? 'current' : 'completed',
      draft ? `状態 ${draft.status}／自動送信なし` : '未作成', 'approval-email-panel'),
    step('draft_review', '人間が文面を確認', !draftCurrent ? 'pending' : draftReviewed ? 'completed' : 'current',
      draftCurrent && draftReviewed ? `判断 ${draft.status}` : draftCurrent && draft?.status === 'quality_blocked' ? '品質不合格。修正が必要' : '送信前の採用・却下記録が必要', 'ae-draft')
  ];

  let nextAction;
  if (stopped) nextAction = { label: '依頼内容・商品数を確認し、新しい依頼としてやり直してください。', target_id: 'extraction-title' };
  else if (!reviewed) nextAction = { label: '抽出結果を原文と照合し、修正下書きを保存してください。', target_id: 'ex-fields' };
  else if (!search || !searchCurrent) nextAction = { label: '引き渡された最新の抽出値を確認し、名寄せ候補を検索してください。', target_id: 'similar-search-panel' };
  else if (search.status === 'entity_review') nextAction = { label: '顧客・商品候補を選び、過去見積を検索してください。', target_id: 'ss-entities' };
  else if (search.status === 'quote_review') nextAction = { label: '類似案件の差異を確認し、採用・却下理由を保存してください。', target_id: 'ss-quotes-panel' };
  else if (!approvalCurrent) nextAction = { label: '最新の類似検索結果を使い、予定価格等を入力して承認要否を判定してください。', target_id: 'approval-email-panel' };
  else if (!draftCurrent) nextAction = { label: `判定結果を確認し、${(output.missing_fields || []).length ? '不足情報確認' : approval.status === 'not_required' ? '見積回答予告' : '社内確認'}の下書きを作成してください。`, target_id: 'approval-email-panel' };
  else if (draft.status === 'quality_blocked') nextAction = { label: '品質検査の指摘を修正し、下書きを再確認してください。', target_id: 'ae-draft' };
  else if (!draftReviewed) nextAction = { label: '文面を人間が照合し、採用または却下の理由を保存してください。', target_id: 'ae-draft' };
  else nextAction = { label: '統合ワークフローの確認は完了です。送信・正式承認はこのMVPの外で行います。', target_id: 'workflow-log' };

  const values = fieldValues(extraction);
  const searchInput = search?.input_payload || null;
  const extractionToSearch = search ? {
    status: search.extraction_revision === extraction.revision ? 'same_revision' : search.extraction_revision === null ? 'legacy_unrecorded' : 'older_reviewed_revision',
    source_extraction_revision: search.extraction_revision,
    current_extraction_revision: extraction.revision,
    transferred_values: searchInput,
    note: '利用者が画面で確認・修正した検索条件を保存。自動確定ではありません。'
  } : { status: 'pending', transferred_values: null };
  const searchToApproval = approval ? {
    status: approval.similar_search_run_id ? 'linked' : 'no_search_link',
    source_similar_search_run_id: approval.similar_search_run_id,
    latest_search_run_id: search?.run_id || null,
    price_analysis_result: approval.approval_result?.rule_results?.find(item => item.rule_id === 'PRICE-001') || null,
    note: '承認判定時点の最新検索結果と価格差異をローカルルールへ引き渡し。'
  } : { status: 'pending' };
  const approvalToDraft = draft ? { status: draftCurrent ? 'linked' : 'older_approval', source_approval_run_id: draft.run_id,
    approval_run_id: approval?.run_id || null, draft_id: draft.draft_id,
    note: '承認結果と抽出結果から下書きを作成。顧客への自動送信はありません。' } : { status: 'pending' };

  const started = bundle.events?.extraction?.find(event => event.event_type === 'started')?.event_summary || {};
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    workflow_id: extraction.run_id,
    request_id: extraction.request_id,
    status: workflowComplete ? 'review_completed' : stopped ? 'blocked' : 'in_progress',
    next_action: nextAction,
    steps,
    input_summary: {
      received_at: extraction.input_payload?.received_at || null,
      request_channel: extraction.input_payload?.request_channel || null,
      case_type: extraction.input_payload?.case_type || null,
      item_scope: extraction.input_payload?.item_scope || null,
      text_length: started.input_length ?? extraction.input_payload?.request_text?.length ?? 0,
      input_hash: started.input_hash || createHash('sha256').update(JSON.stringify(extraction.input_payload || {})).digest('hex'),
      raw_text_in_workflow_response: false
    },
    handoffs: { extraction_to_search: extractionToSearch, search_to_approval: searchToApproval, approval_to_draft: approvalToDraft },
    results: {
      extraction: { revision: extraction.revision, status: output.status, extracted_fields: values,
        missing_fields: output.missing_fields || [], warnings_and_holds: output.warnings_and_holds || [] },
      similar_search: search ? { run_id: search.run_id, status: search.status,
        selected_customer: search.selected_customer, selected_product: search.selected_product,
        top_similar_cases: (search.similar_quotes || []).slice(0, 5).map(quoteSummary), decision: search.decision } : null,
      approval: approval ? { run_id: approval.run_id, status: approval.status,
        result: approval.approval_result, rule_version: approval.rule_version } : null,
      draft: draft ? { draft_id: draft.draft_id, current: draftCurrent, status: draft.status, draft_type: draft.draft_type,
        generation_method: draft.generation_method, subject: draft.subject || draft.draft_payload?.subject,
        body: draft.body || draft.draft_payload?.body, quality: draft.quality_result,
        human_review: draft.human_review, auto_send: false } : null
    },
    logs: normalizedEvents(bundle),
    security: { external_ai_calls_in_workflow_orchestration: 0, raw_request_text_returned: false,
      human_checkpoints_preserved: ['extraction_review','similar_case_decision','approval_review','draft_review'],
      auto_send: false }
  };
}

export function createWorkflowService({ store }) {
  return {
    async get(extractionId) {
      const bundle = await store.get(extractionId);
      if (!bundle) throw new ExtractionError('NOT_FOUND', '対象の統合ワークフローがありません。', 404);
      return buildWorkflow(bundle);
    }
  };
}
