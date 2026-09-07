import { randomUUID } from 'node:crypto';
import { ExtractionError } from './extraction.mjs';
import { APPROVAL_RULE_VERSION, APPROVAL_SCHEMA_VERSION, evaluateApproval, RULE_POLICY } from './approval-rules.mjs';
import { checkDraftQuality, composeGeminiDraft, DRAFT_PROMPT_VERSION, DRAFT_SCHEMA_VERSION, DRAFT_TYPES, externalPreview,
  geminiDraft, hydrateDraft, localTemplate, validateDraftInput } from './email-drafts.mjs';
import { FIELD_LABELS } from './extraction-schema.mjs';
import { auditIdentity, currentUser } from './request-context.mjs';

function draftPayload(row) {
  return { draft_id: row.draft_id, run_id: row.run_id, draft_type: row.draft_type, recipient_role: row.recipient_role,
    generation_method: row.generation_method, model: row.model, prompt_version: row.prompt_version,
    external_preview: row.external_preview, draft: { subject: row.subject || row.draft_payload?.subject,
      body: row.body || row.draft_payload?.body, referenced_item_ids: row.draft_payload?.referenced_item_ids || [] },
    quality: row.quality_result, status: row.status, human_review: row.human_review, revision: row.revision,
    created_at: row.created_at, updated_at: row.updated_at, security: { auto_send: false, send_endpoint: false } };
}

function payload(record, drafts = []) {
  return { schema_version: APPROVAL_SCHEMA_VERSION, run_id: record.run_id, extraction_run_id: record.extraction_run_id,
    request_id: record.request_id, similar_search_run_id: record.similar_search_run_id,
    status: record.status, rule_version: record.rule_version,
    input: record.input_payload, approval: record.approval_result, drafts: drafts.map(draftPayload),
    created_at: record.created_at, security: { approval_execution: 'local_deterministic_rules',
      final_decision_by_ai: false, auto_send: false, send_endpoint: false } };
}

function validateModelFragment(fragment) {
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)
    || Object.keys(fragment).some(k => !['opening','closing'].includes(k))
    || typeof fragment.opening !== 'string' || !fragment.opening.trim() || fragment.opening.length > 240
    || typeof fragment.closing !== 'string' || !fragment.closing.trim() || fragment.closing.length > 240
    || /[\r\n]/u.test(fragment.opening) || /[\r\n]/u.test(fragment.closing))
    throw new ExtractionError('DRAFT_AI_SCHEMA_INVALID', 'AIの匿名文面が固定形式に一致しないため採用しません。', 502);
  const combined = `${fragment.opening}\n${fragment.closing}`;
  if (/[\[\]]|顧客名|商品名|品番|案件番号|担当者名|不足項目|追加確認事項|\d/u.test(combined))
    throw new ExtractionError('DRAFT_AI_CONTENT_INVALID', 'AIの匿名文面に個別情報・プレースホルダー・数値が含まれるため採用しません。', 502);
  return { opening: fragment.opening.trim(), closing: fragment.closing.trim() };
}

export function createApprovalEmailService({ extractionStore, similarSearch, store, ai, fetchFn = fetch }) {
  async function resolveDraftInput(record, body) {
    const requested = validateDraftInput(body);
    const extraction = await extractionStore.get(record.extraction_run_id);
    if (!extraction) throw new ExtractionError('NOT_FOUND', '関連する抽出記録がありません。', 404);
    if (record.approval_result.extraction_revision !== extraction.revision)
      throw new ExtractionError('APPROVAL_STALE', '承認判定後に抽出結果が更新されています。最新の抽出結果で承認要否を再判定してください。', 409);
    const fields = extraction.output_payload.extracted_fields;
    return { ...requested,
      customer_name: fields.customer_name?.value || null,
      product_label: [fields.product_code?.value, fields.product_name?.value].filter(Boolean).join(' / ') || null,
      request_id: extraction.output_payload.request_id,
      missing_items: (extraction.output_payload.missing_fields || []).map(item => ({ id: item.field_name,
        label: FIELD_LABELS[item.field_name] || item.field_name })) };
  }

  return {
    config() {
      return { schema_version: APPROVAL_SCHEMA_VERSION, rule_version: APPROVAL_RULE_VERSION, policy: RULE_POLICY,
        draft_schema_version: DRAFT_SCHEMA_VERSION, prompt_version: DRAFT_PROMPT_VERSION, draft_types: DRAFT_TYPES,
        gemini_configured: ai.provider === 'gemini' && Boolean(ai.apiKey), model: ai.model,
        constraints: ['価格を断定しない', '納期を確約しない', '自動送信しない'],
        quality_criteria: ['禁止表現の不在','情報の正確性','宛先の適切性','不足情報の網羅','敬語・文体の適切さ'] };
    },
    async evaluate(extractionId, body) {
      const extraction = await extractionStore.get(extractionId);
      if (!extraction) throw new ExtractionError('NOT_FOUND', '対象の抽出記録がありません。', 404);
      let search = null;
      try { search = await similarSearch.latest(extractionId); } catch {}
      if (!search) throw new ExtractionError('WORKFLOW_SEARCH_REQUIRED', '先に名寄せ・類似案件検索を実行し、候補の判断理由を保存してください。', 409);
      if (search.extraction_revision !== extraction.revision)
        throw new ExtractionError('WORKFLOW_SEARCH_STALE', '抽出結果の保存後に類似案件検索が更新されていません。最新の抽出値でもう一度検索してください。', 409);
      if (search.status !== 'reviewed')
        throw new ExtractionError('WORKFLOW_SEARCH_REVIEW_REQUIRED', '類似案件の採用・却下理由を保存してから承認要否を判定してください。', 409);
      const approval = evaluateApproval({ extraction, priceAnalysis: search?.price_analysis || null, rawInput: body });
      const run = { run_id: randomUUID(), extraction_run_id: extractionId,
        request_id: extraction.output_payload.request_id, similar_search_run_id: search?.run_id || null,
        input: approval.input_values, approval };
      await store.create(run);
      return payload(await store.get(run.run_id), []);
    },
    async get(runId) {
      const record = await store.get(runId);
      if (!record) throw new ExtractionError('APPROVAL_RUN_NOT_FOUND', '承認判定記録がありません。', 404);
      return payload(record, await store.drafts(runId));
    },
    async latest(extractionId) {
      const record = await store.latest(extractionId);
      return record ? payload(record, await store.drafts(record.run_id)) : null;
    },
    async preview(runId, body) {
      const record = await store.get(runId);
      if (!record) throw new ExtractionError('APPROVAL_RUN_NOT_FOUND', '承認判定記録がありません。', 404);
      const input = await resolveDraftInput(record, body);
      return { preview: externalPreview(input), security: { external_ai_calls: 0, consent_recorded: false,
        auto_send: false, send_endpoint: false } };
    },
    async draft(runId, body) {
      const record = await store.get(runId);
      if (!record) throw new ExtractionError('APPROVAL_RUN_NOT_FOUND', '承認判定記録がありません。', 404);
      const input = await resolveDraftInput(record, body);
      if (DRAFT_TYPES[input.draft_type].audience === 'customer' && !input.customer_reference)
        throw new ExtractionError('CUSTOMER_REFERENCE_REQUIRED', '顧客向け文面には、顧客が認識できる問い合わせ番号または元メール件名を入力してください。', 400);
      if (input.draft_type === 'customer_inquiry' && !input.missing_items.length && !input.questions.length)
        throw new ExtractionError('DRAFT_PURPOSE_MISSING', '顧客へ確認する不足項目または質問がありません。');
      if (input.draft_type === 'quote_notice' && record.approval_result.status !== 'not_required')
        throw new ExtractionError('QUOTE_DRAFT_HELD', '保留または承認必要の案件では、顧客向け見積回答予告を作成できません。', 409);
      if (input.draft_type === 'internal_review' && record.approval_result.status === 'not_required' && !input.questions.length)
        throw new ExtractionError('DRAFT_PURPOSE_MISSING', '社内へ確認する理由または質問がありません。');
      const preview = externalPreview(input);
      let raw, attempts = 0;
      if (input.mode === 'gemini') {
        if (!input.consent) throw new ExtractionError('SEND_CONSENT_REQUIRED', '表示された匿名・最小化データを確認し、今回の送信に同意してください。', 403);
        if (ai.provider !== 'gemini' || !ai.apiKey) throw new ExtractionError('AI_NOT_CONFIGURED', 'Geminiの接続設定がありません。外部送信していません。', 503);
        attempts = 1;
        raw = validateModelFragment(await geminiDraft({ preview, ai, fetchFn }));
      } else raw = localTemplate(input);
      const hydrated = input.mode === 'gemini'
        ? hydrateDraft(composeGeminiDraft(raw, input), input)
        : hydrateDraft(raw, input);
      const quality = checkDraftQuality(hydrated, input);
      const created = await store.saveDraft(runId, { draft_id: randomUUID(), draft_type: input.draft_type,
        recipient_role: input.recipient_role, generation_method: input.mode === 'gemini' ? 'gemini_sanitized' : 'local_template',
        model: input.mode === 'gemini' ? ai.model : null, prompt_version: DRAFT_PROMPT_VERSION,
        external_preview: input.mode === 'gemini' ? preview : null, payload: hydrated, quality,
        generation_input: input,
        status: quality.passed ? 'pending_review' : 'quality_blocked', external_ai_calls: attempts });
      return draftPayload(created);
    },
    async review(runId, draftId, body) {
      const allowed = new Set(['subject','body','decision','reason','reviewer']);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.has(k))
        || !['adopted','rejected'].includes(body.decision) || typeof body.subject !== 'string' || !body.subject.trim()
        || body.subject.length > 150 || typeof body.body !== 'string' || !body.body.trim() || body.body.length > 3000
        || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000
        || typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.length > 100)
        throw new ExtractionError('DRAFT_REVIEW_INVALID', '文面、採用・却下、理由、記録者を入力してください。');
      const existing = await store.getDraft(runId, draftId);
      if (!existing) throw new ExtractionError('DRAFT_NOT_FOUND', '対象の文面下書きがありません。', 404);
      const edited = { subject: body.subject.trim(), body: body.body.trim(),
        referenced_item_ids: existing.draft_payload?.referenced_item_ids || [] };
      const quality = checkDraftQuality(edited, existing.generation_input);
      if (body.decision === 'adopted' && !quality.passed)
        throw new ExtractionError('DRAFT_QUALITY_BLOCKED', `禁止表現・形式を修正してください：${quality.violations.map(v => v.message).join(' / ')}`, 409);
      const identity = auditIdentity();
      const review = { subject: edited.subject, body: edited.body, decision: body.decision,
        reason: body.reason.trim(), reviewer: currentUser()?.displayName || body.reviewer.trim(), reviewed_at: new Date().toISOString(),
        quality, identity_mode: identity.identity_mode, execution_user_id: identity.execution_user_id,
        note: '下書きの確認記録であり、送信・価格確定・納期確約ではありません。' };
      const row = await store.saveDraftReview(runId, draftId, review);
      if (!row) throw new ExtractionError('DRAFT_NOT_FOUND', '対象の文面下書きがありません。', 404);
      return draftPayload(row);
    }
  };
}
