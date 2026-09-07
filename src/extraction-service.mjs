import { randomUUID } from 'node:crypto';
import { assertOutput, baseOutput, checkQuantityUnit, ExtractionError, extractLocally, normalizeResult, refreshMissing, scopeDetails, scopeWarning, validateInput, warning } from './extraction.mjs';
import { UNITS } from './extraction-evidence.mjs';
import { extractWithGemini, prepareExternal } from './extraction-gemini.mjs';
import { FIELD_LABELS, PROMPT_VERSION, RULE_VERSION } from './extraction-schema.mjs';
import { assessSingleItem } from './extraction-scope.mjs';
import { emptyBusiness, prepareBusiness } from './business-review.mjs';
import { auditIdentity, currentUser } from './request-context.mjs';

export function createExtractionService({ store, ai, fetchFn = fetch }) {
  let busy = false;
  return {
    async extract(rawInput) {
      const input = validateInput(rawInput);
      if (busy) throw new ExtractionError('BUSY', '別の抽出を処理中です。完了してから試してください。', 409);
      busy = true;
      const id = randomUUID();
      const output = baseOutput();
      const execution = { mode: input.mode, model: input.mode === 'gemini' ? ai.model : null,
        ...auditIdentity(),
        prompt_version: PROMPT_VERSION, rule_version: RULE_VERSION,
        external_attempts: 0, verified_external_extraction: false, verified_external_response: false,
        extraction_method: 'not_extracted',
        scope_decision: { model_scope: null, local_assessment: assessSingleItem(input), outcome: 'not_evaluated' },
        started_at: new Date().toISOString(), completed_at: null };
      let started = false;
      try {
        await store.start(id, input, { ...output, status: 'processing' }, execution);
        started = true;
        output.audit_log_id = id;
        const scopeHold = scopeWarning(input);
        if (scopeHold) { output.warnings_and_holds.push(scopeHold); scopeDetails(input, output); execution.scope_decision.outcome = 'whole_request_hold'; }
        else {
          let modelOutput;
          if (input.mode === 'gemini') {
            const text = prepareExternal(input);
            if (input.consent !== true) throw new ExtractionError('SEND_CONSENT_REQUIRED', '送信先・匿名サンプルの内容を確認して、今回の送信に同意してください。', 403);
            if (ai.provider !== 'gemini' || !ai.apiKey) throw new ExtractionError('AI_NOT_CONFIGURED', 'Geminiの接続設定がありません。外部送信していません。', 503);
            execution.external_attempts = 1;
            modelOutput = await extractWithGemini({ text, apiKey: ai.apiKey, model: ai.model, fetchFn });
            // Model quotes must refer to the original locally retained source after token restoration.
            for (const field of Object.values(modelOutput?.fields || {})) {
              if (typeof field?.source_quote === 'string') field.source_quote = field.source_quote.split('[CUSTOMER]').join(input.customer_name);
              if (typeof field?.candidate === 'string') field.candidate = field.candidate.split('[CUSTOMER]').join(input.customer_name);
            }
            normalizeResult(input, modelOutput, output, execution.scope_decision);
            execution.extraction_method = execution.scope_decision.outcome === 'local_labelled_fallback' ? 'local_labelled_fallback'
              : execution.scope_decision.outcome === 'whole_request_hold' ? 'not_extracted' : 'gemini_fields';
            execution.verified_external_response = true;
            execution.verified_external_extraction = execution.extraction_method === 'gemini_fields';
          } else {
            modelOutput = extractLocally(input.request_text);
            normalizeResult(input, modelOutput, output, execution.scope_decision);
            execution.scope_decision.model_scope = null;
            execution.extraction_method = execution.scope_decision.outcome === 'whole_request_hold' ? 'not_extracted' : 'local_baseline';
            if (execution.extraction_method === 'local_baseline') execution.scope_decision.outcome = 'local_baseline';
            output.warnings_and_holds.push(warning('LOCAL_RULE_BASELINE', 'ローカル簡易抽出です。AIを使用しておらず、自然文へのAI抽出精度の確認にはなりません。', 'system', 'info'));
          }
        }
        output.warnings_and_holds.push(warning('HUMAN_CONFIRMATION_REQUIRED', 'デモ環境です。AI・ルールの結果だけで価格、納期、承認、加工種別を確定しないでください。', 'system', 'warning'));
        execution.completed_at = new Date().toISOString();
        assertOutput(output);
        await store.finish(id, output, execution);
        return { output, execution, revision: 1, business_review: emptyBusiness(output), initial_output: structuredClone(output), review_history: [] };
      } catch (error) {
        output.status = 'error';
        const known = error instanceof ExtractionError;
        output.warnings_and_holds.push(warning(known ? error.code : 'AUDIT_STORAGE_FAILED', known ? error.message : '記録の保存に失敗しました。処理を完了せず停止しました。'));
        execution.completed_at = new Date().toISOString();
        if (started) {
          try { await store.finish(id, output, execution); }
          catch { output.audit_log_id = null; output.warnings_and_holds.push(warning('AUDIT_STORAGE_FAILED', '監査記録を保存できません。既存の手動業務へ戻してください。')); }
        } else output.audit_log_id = null;
        assertOutput(output);
        return { output, execution, revision: null };
      } finally { busy = false; }
    },
    async review(id, body) {
      if (!/^[0-9a-f-]{36}$/i.test(id) || !body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(k => !['revision', 'values', 'acknowledged', 'business_review'].includes(k))
        || !Number.isInteger(body.revision) || body.acknowledged !== true)
        throw new ExtractionError('REVIEW_INVALID', '確認対象・版・原文照合チェックを確認してください。');
      const record = await store.get(id);
      if (!record) throw new ExtractionError('NOT_FOUND', '対象の抽出記録がありません。', 404);
      if (record.revision !== body.revision) throw new ExtractionError('STALE_REVIEW', '別の確認操作で記録が更新されました。履歴を再表示してください。', 409);
      const output = structuredClone(record.output_payload);
      if (output.status === 'error' || output.warnings_and_holds.some(w => ['MULTIPLE_ITEMS', 'OUT_OF_MVP', 'OUT_OF_SCOPE', 'ITEM_COUNT_UNCERTAIN', 'SCOPE_UNCERTAIN'].includes(w.code)))
        throw new ExtractionError('REVIEW_HELD', '対象外・商品数不明・エラーの依頼は、確認操作で解除できません。', 409);
      if (!body.values || Array.isArray(body.values) || typeof body.values !== 'object'
        || Object.keys(body.values).length !== Object.keys(FIELD_LABELS).length
        || Object.keys(body.values).some(k => !Object.hasOwn(FIELD_LABELS, k)))
        throw new ExtractionError('REVIEW_FIELDS', '確認項目が一致しません。');
      const changes = [];
      for (const [key, value] of Object.entries(body.values)) {
        const valid = value === null || (key === 'quantity' ? typeof value === 'number' && Number.isFinite(value) && value > 0
          : typeof value === 'string' && value.trim().length > 0 && value.length <= 1000);
        if (!valid || (key === 'quantity_unit' && value !== null && !UNITS.includes(value.normalize('NFKC')))
          || (key === 'requested_delivery_date' && value !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(value)
          || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
          || value < record.input_payload.received_at.slice(0, 10))))
          throw new ExtractionError('REVIEW_VALUE', `${FIELD_LABELS[key]}の型・値・日付を確認してください。`);
        const field = output.extracted_fields[key];
        if (field.value !== value) changes.push({ field_name: key, before: field.value, after: value });
        field.value = value;
        // Draft review only: authenticated final confirmation is outside this step.
        field.human_status = 'pending';
      }
      output.status = 'needs_review';
      checkQuantityUnit(output);
      refreshMissing(output);
      assertOutput(output);
      const user = currentUser();
      const submittedBusiness = body.business_review && user
        ? { ...body.business_review, recorder: user.displayName }
        : body.business_review;
      const { business, reopened } = prepareBusiness(record, output, changes, submittedBusiness);
      const revision = await store.saveReview(id, body.revision, output, changes, business);
      if (revision === null) throw new ExtractionError('STALE_REVIEW', '別の確認操作で記録が更新されました。履歴を再表示してください。', 409);
      return { output, execution: record.execution, revision, business_review: business, initial_output: record.initial_output || null,
        review_history: store.history ? await store.history(id) : [], reopened_topics: reopened,
        message: `修正下書き・確認記録を保存しました。正式な確認済み・後工程への引渡しではありません。${reopened.length ? ' 値の変更により再確認へ戻した項目があります。' : ''}` };
    },
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ExtractionError('INVALID_ID', '記録IDが不正です。');
      const record = await store.get(id);
      if (!record) throw new ExtractionError('NOT_FOUND', '対象の抽出記録がありません。', 404);
      return { output: record.output_payload, execution: record.execution, revision: record.revision,
        business_review: record.business_review || emptyBusiness(record.output_payload), initial_output: record.initial_output || null,
        review_history: store.history ? await store.history(id) : [] };
    }
  };
}
