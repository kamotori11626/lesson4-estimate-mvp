import { randomUUID } from 'node:crypto';
import { blankModel, FIELD_LABELS, MAX_TEXT_LENGTH, MODEL_FIELDS, MODEL_SCHEMA, matchesSchema, OUTPUT_SCHEMA, SCHEMA_VERSION } from './extraction-schema.mjs';
import { AMBIGUITY, ambiguityIsGrounded, explicitDate, hasCredential, inspectField, isSingleItemQuantityConflict, locateQuote, numbers, quantityMentions, unitInQuote } from './extraction-evidence.mjs';
import { assessSingleItem, itemScopeRisk } from './extraction-scope.mjs';

export class ExtractionError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function validateInput(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ExtractionError('INVALID_INPUT', '入力形式を確認してください。');
  const allowed = ['schema_version', 'customer_name', 'received_at', 'request_channel', 'case_type', 'item_scope', 'request_text', 'mode', 'consent'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ExtractionError('UNKNOWN_INPUT', '未対応の入力項目があります。添付原本や価格項目は受け付けません。');
  if (input.schema_version !== SCHEMA_VERSION) throw new ExtractionError('SCHEMA_VERSION', '画面を再読み込みしてください。入力仕様の版が一致しません。');
  if (typeof input.customer_name !== 'string' || !input.customer_name.trim() || input.customer_name.length > 200)
    throw new ExtractionError('CUSTOMER_REQUIRED', '顧客名を1〜200文字で入力してください。');
  if (typeof input.request_text !== 'string' || !input.request_text.trim() || input.request_text.length > MAX_TEXT_LENGTH)
    throw new ExtractionError('TEXT_LENGTH', `依頼文を1〜${MAX_TEXT_LENGTH}文字で入力してください。長文は切り捨てません。`);
  if (typeof input.received_at !== 'string' || !/T\d\d:\d\d.*(?:Z|[+-]\d\d:\d\d)$/.test(input.received_at)
    || explicitDate(input.received_at.slice(0, 10)) !== input.received_at.slice(0, 10)
    || !Number.isFinite(Date.parse(input.received_at)) || Date.parse(input.received_at) > now.getTime())
    throw new ExtractionError('RECEIVED_AT', '受付日時はタイムゾーン付きの有効な日時で、未来日時ではない必要があります。');
  if (!['email', 'web', 'fax', 'phone', 'other'].includes(input.request_channel)
    || !['規格品', '類似品', '新規特注', '緊急'].includes(input.case_type)
    || !['single', 'multiple', 'unknown'].includes(input.item_scope)
    || !['local', 'gemini'].includes(input.mode)
    || (input.consent !== undefined && typeof input.consent !== 'boolean'))
    throw new ExtractionError('INVALID_SELECTION', '受付経路・案件種別・商品数・処理方式を選び直してください。');
  if (hasCredential(input.request_text) || hasCredential(input.customer_name))
    throw new ExtractionError('CREDENTIAL_INPUT', '認証情報らしき記述があります。入力・保存・外部送信を停止しました。');
  return { ...input, customer_name: input.customer_name.trim() };
}

const ACTIONS = {
  LOCAL_SCOPE_FALLBACK: 'AIの商品数不明判定は記録に残しています。本文全体の単一商品根拠と、ローカル抽出した各項目を照合してください。AI抽出成功・確認済みとして扱わず、追記や別商品があれば依頼全体を保留してください。',
  AMBIGUOUS: '入力者が引用箇所を照合し、依頼元への確認事項を整理してください。不明値は確定せず、正式な確認担当へ引き継いでください。',
  CONFLICTING_VALUES: '入力者が両方の記載と訂正の経緯を確認してください。最新・最大・高信頼度という理由だけで選ばず、依頼元または正式な確認担当へ確認してください。',
  EVIDENCE_INVALID: '入力者が原文と項目の対応を確認してください。根拠のない候補を採用せず、必要なら手動処理へ戻してください。',
  AMBIGUITY_UNVERIFIED: 'AIの曖昧判定は未採用です。入力者が原文を確認し、未記載か抽出漏れかを確認してください。',
  INVALID_VALUE: '入力者が数量・単位・日付を依頼元に確認してください。0埋めや推測で補正しないでください。',
  UNIT_UNCONFIRMED: '数量と単位の組合せを原文で確認してください。未対応単位の変換や単位の推測はしないでください。',
  UNIT_MISSING: '数量の単位が必要です。依頼元または正式な確認担当に確認し、推測で補わないでください。',
  AI_HTTP_ERROR: 'システム障害です。入力不足ではありません。自動再試行せず、運用担当へ連絡するか既存の手動業務へ戻してください。',
  AI_TIMEOUT: '応答時間切れです。重複実行を避けて処理記録を確認し、運用担当へ連絡してください。',
  AUDIT_STORAGE_FAILED: '保存を確認できないため後工程へ進めません。運用担当が保存状態を確認してください。',
  EXTERNAL_DATA_NOT_APPROVED: 'この本文は送信許可の対象外です。承認済み匿名サンプルへ戻すか、外部送信しない手動業務へ切り替えてください。'
};
export const warning = (code, message, source = 'request_text', severity = 'hold', required_action = ACTIONS[code] || '入力者が原文・停止理由を確認し、正式な確認担当または運用担当へ引き継いでください。後工程への確定入力は禁止です。') =>
  ({ code, severity, message, source, required_action });

export function scopeWarning(input) {
  const text = input.request_text.normalize('NFKC');
  const labels = text.match(/(?:^|\n)\s*(?:品番|品名|商品名)\s*[:：]/g) || [];
  const productCodes = [...text.matchAll(/(?:^|\n)\s*品番\s*[:：]\s*([^\n]+)/g)];
  const productNames = [...text.matchAll(/(?:^|\n)\s*(?:品名|商品名)\s*[:：]\s*([^\n]+)/g)];
  if (input.item_scope === 'multiple' || /複数(?:の)?商品|[2-9２-９]商品|[2-9]品目|二商品|二品目/.test(text)
    || productCodes.length > 1 || productNames.length > 1 || labels.length > 2)
    return warning('MULTIPLE_ITEMS', '複数商品の依頼です。先頭商品だけを採用せず、依頼全体を保留しました。');
  if (['新規特注', '緊急'].includes(input.case_type) || /外注見積(?:が)?必須|複雑な図面判断/.test(text))
    return warning('OUT_OF_MVP', '今回のMVP対象外です。既存の人間の手順へ切り替えてください。');
  if (/天気|観光地|レストラン|占い/.test(text) && !/見積|品番|品名|数量/.test(text))
    return warning('OUT_OF_SCOPE', '見積依頼の業務外として記録しました。抽出対象外です。');
  if (quantityMentions(text).length > 1 && !isSingleItemQuantityConflict(input))
    return warning('ITEM_COUNT_UNCERTAIN', '複数の数量表現があります。複数商品か数量の訂正かを判別せず、依頼全体を保留しました。');
  if (input.item_scope !== 'single') return warning('ITEM_COUNT_UNCERTAIN', '商品数が未確認のため依頼全体を保留しました。');
  const risk = itemScopeRisk(input);
  if (risk) return warning(risk === 'multiple' ? 'MULTIPLE_ITEMS' : 'ITEM_COUNT_UNCERTAIN',
    risk === 'multiple' ? '複数の商品・品目の記載があるため、依頼全体を保留しました。'
      : '商品の列挙・前回一式・別商品の参照などがあり、商品数を確定できないため依頼全体を保留しました。');
  return null;
}

// Offline, labelled-text baseline; never presented as an LLM result or accuracy evidence.
export function extractLocally(text) {
  const result = blankModel();
  const aliases = { product_name: '品名|商品名', product_code: '品番', quantity: '数量',
    quantity_unit: '単位', material: '材質', dimensions: '寸法', tolerance: '公差', requested_delivery_date: '希望納期' };
  for (const [key, labels] of Object.entries(aliases)) {
    const matches = [...text.matchAll(new RegExp(`(?:^|\\n)\\s*(?:${labels})\\s*[:：]\\s*([^\\n]+)`, 'g'))];
    if (!matches.length) continue;
    const quote = matches[0][1].trim();
    const ambiguous = matches.length !== 1 || /不明|未定|前回|同様|ごろ|頃|ほど|約|来月|来週|上旬|中旬|下旬|半ば|または/.test(quote);
    let value = quote;
    if (key === 'quantity') {
      const match = quote.normalize('NFKC').match(/^([+-]?\d[\d,]*(?:\.\d+)?)\s*(個|本|枚|台|組|セット|式|kg|g|m|mm)?$/);
      value = match ? Number(match[1].replaceAll(',', '')) : null;
      if (match?.[2]) result.fields.quantity_unit = { value: match[2], source_quote: quote, confidence: null, ambiguous, candidate: ambiguous ? quote : null };
    }
    if (key === 'requested_delivery_date') value = explicitDate(quote);
    const isAmbiguous = ambiguous || (value === null && quote !== '');
    result.fields[key] = { value: isAmbiguous ? null : value, source_quote: quote,
      confidence: null, ambiguous: isAmbiguous, candidate: isAmbiguous ? quote : null };
  }
  return result;
}

function groundedValue(key, value, quote) {
  const normalized = quote.normalize('NFKC');
  if (key === 'quantity') return typeof value === 'number' && value > 0
    && numbers(normalized).length === 1 && numbers(normalized)[0] === value;
  if (key === 'quantity_unit') return unitInQuote(value, quote);
  if (key === 'requested_delivery_date') return value === explicitDate(quote);
  return typeof value === 'string' && value.trim().length > 0 && normalized.includes(value.normalize('NFKC'));
}

function blankField() { return { value: null, source_quote: null, source_location: null, confidence: null, human_status: 'pending' }; }

function setEvidence(field, evidence) {
  if (!evidence) return;
  field.source_quote = evidence.quote;
  field.source_location = { source_id: 'request_text', start: evidence.start, end: evidence.end };
}

export function scopeDetails(input, output) {
  if (!output.warnings_and_holds.some(w => w.code === 'ITEM_COUNT_UNCERTAIN')) return;
  const mentions = quantityMentions(input.request_text);
  if (mentions.length > 1) output.warnings_and_holds.push(warning('CONFLICTING_VALUES',
    `複数数量・訂正の可能性があります。どちらも採用していません。${mentions.map(m => `「${m.quote}」 [${m.start}, ${m.end})`).join(' / ')}`, 'quantity'));
}

export function baseOutput(requestId = randomUUID()) {
  return { schema_version: SCHEMA_VERSION, request_id: requestId, status: 'needs_review',
    extracted_fields: Object.fromEntries(Object.keys(FIELD_LABELS).map(key => [key, blankField()])),
    missing_fields: [], warnings_and_holds: [], audit_log_id: null };
}

export function normalizeResult(input, modelOutput, output = baseOutput(), scopeAudit = {}) {
  if (!matchesSchema(modelOutput, MODEL_SCHEMA)) throw new ExtractionError('MODEL_SCHEMA_INVALID', 'AIの出力形式が仕様と一致しません。結果を採用せず手動確認へ戻してください。', 502);
  const assessment = assessSingleItem(input);
  Object.assign(scopeAudit, { model_scope: modelOutput.scope, local_assessment: assessment, outcome: 'model_fields' });
  const preflightHold = scopeWarning(input);
  if (preflightHold) {
    scopeAudit.outcome = 'whole_request_hold';
    output.warnings_and_holds.push(preflightHold); scopeDetails(input, output);
    return output;
  }
  let fieldsOutput = modelOutput;
  if (modelOutput.scope !== 'single') {
    if (modelOutput.scope === 'uncertain' && assessment.classification === 'single_labelled') {
      // Do not change the model's decision or reuse its withheld fields. Independently
      // extract the understood labelled source. Never make another provider call.
      fieldsOutput = extractLocally(input.request_text);
      scopeAudit.outcome = 'local_labelled_fallback';
      const roots = assessment.evidence.filter(e => e.kind === 'item_identity');
      output.warnings_and_holds.push(warning('LOCAL_SCOPE_FALLBACK',
        `AIは商品数・業務範囲を不明としました。本文全体が対応済みの単一商品書式と確認できたため、原文からローカル抽出した未確認下書きを表示します。AI判定の成功ではありません。 単一商品根拠: ${roots.map(e => `「${e.source_quote}」 [${e.source_location.start}, ${e.source_location.end})`).join(' / ')}`,
        'request_text', 'warning'));
    } else {
      const details = {
        multiple: ['MULTIPLE_ITEMS', 'AIが複数商品と判定しました。先頭商品だけを採用せず、依頼全体を保留しました。'],
        uncertain: ['SCOPE_UNCERTAIN', 'AIが商品数または見積依頼としての業務範囲を判別できませんでした。抽出値は採用せず、依頼全体を保留しました。'],
        out_of_scope: ['OUT_OF_SCOPE', 'AIが見積依頼の業務外と判定しました。抽出対象外として依頼全体を保留しました。']
      }[modelOutput.scope];
      output.warnings_and_holds.push(warning(...details));
      scopeAudit.outcome = 'whole_request_hold';
      return output;
    }
  }
  output.extracted_fields.customer_name = { value: input.customer_name, source_quote: input.customer_name,
    source_location: { source_id: 'customer_name', start: 0, end: input.customer_name.length }, confidence: null, human_status: 'pending' };
  for (const key of MODEL_FIELDS) {
    const proposed = fieldsOutput.fields[key];
    const field = output.extracted_fields[key];
    const evidence = locateQuote(input.request_text, proposed.source_quote, key);
    const observed = inspectField(input.request_text, key);
    setEvidence(field, evidence);
    if (observed) {
      if (observed.evidence.quote.length > 1000) {
        output.warnings_and_holds.push(warning('EVIDENCE_INVALID', `${FIELD_LABELS[key]}の根拠引用が上限を超えるため、値と判定を採用していません。原文を短縮・切捨てせず、手動確認してください。`, key));
        continue;
      }
      // Recover ONLY actual, field-labelled evidence. Never fill a business value from a guess.
      setEvidence(field, observed.evidence);
      const reason = observed.code === 'CONFLICTING_VALUES' ? 'に矛盾・訂正候補があり、どれも選択していません。'
        : observed.code === 'INVALID_VALUE' ? 'に無効な値があり、採用していません。' : 'に曖昧さがあります。確定値は空欄です。';
      output.warnings_and_holds.push(warning(observed.code,
        `${FIELD_LABELS[key]}${reason} 原文: ${observed.detail || `「${observed.evidence.quote}」 [${observed.evidence.start}, ${observed.evidence.end})`}`, key));
    } else if (proposed.ambiguous || (evidence && AMBIGUITY.test(evidence.quote))) {
      if (ambiguityIsGrounded(input.request_text, key, evidence)) {
        output.warnings_and_holds.push(warning('AMBIGUOUS', `${FIELD_LABELS[key]}に曖昧さがあります。確定値は空欄です。 原文: 「${evidence.quote}」 [${evidence.start}, ${evidence.end})`, key));
      } else {
        output.warnings_and_holds.push(warning('AMBIGUITY_UNVERIFIED', `${FIELD_LABELS[key]}の曖昧判定は原文根拠を確認できないため未採用です。情報不足か抽出漏れかを確認してください。`, key));
      }
    } else if (proposed.value !== null) {
      if (!evidence || !groundedValue(key, proposed.value, evidence.quote)) {
        const code = key === 'quantity_unit' && evidence ? 'UNIT_UNCONFIRMED' : 'EVIDENCE_INVALID';
        output.warnings_and_holds.push(warning(code, code === 'UNIT_UNCONFIRMED'
          ? '単位の対応・原文との一致を確認できません。候補を採用せず、単位を要確認にしました。'
          : `${FIELD_LABELS[key]}の値と原文の対応を確認できません。候補を採用しませんでした。`, key));
      } else if (key === 'requested_delivery_date' && proposed.value < input.received_at.slice(0, 10)) {
        output.warnings_and_holds.push(warning('PAST_DELIVERY', '希望納期が受付日より前です。日付を確認してください。', key));
      } else {
        field.value = proposed.value;
        field.confidence = proposed.confidence;
      }
    } else if (proposed.source_quote !== null && !evidence) {
      output.warnings_and_holds.push(warning('EVIDENCE_INVALID', `${FIELD_LABELS[key]}の引用が原文に見つかりません。`, key));
    }
  }
  checkQuantityUnit(output);
  refreshMissing(output);
  output.warnings_and_holds.push(warning('HUMAN_REVIEW_REQUIRED', '抽出候補です。原文と照合し、必要な修正を行ってください。', 'system', 'warning'));
  return output;
}

export function refreshMissing(output) {
  // All absent extraction fields are displayed. No unapproved per-case mandatory rule is invented.
  output.missing_fields = Object.entries(output.extracted_fields).filter(([, f]) => f.value === null)
    .map(([key]) => {
      const codes = output.warnings_and_holds.filter(w => w.source === key).map(w => w.code);
      const reason = codes.includes('CONFLICTING_VALUES') ? '矛盾・訂正あり：原文の両方の記載を確認してください。'
        : codes.includes('INVALID_VALUE') || codes.includes('PAST_DELIVERY') ? '無効な値：数量・日付等を確認してください。'
        : codes.includes('AMBIGUOUS') ? '曖昧：原文の要確認表現を確認してください。推測で確定しないでください。'
        : codes.includes('AMBIGUITY_UNVERIFIED') ? '情報不足（原文根拠未確認）：未記載か抽出漏れかを確認してください。AIの曖昧判定は未採用です。'
        : codes.includes('EVIDENCE_INVALID') ? '根拠不一致：原文と候補の対応を確認できません。'
        : codes.includes('UNIT_UNCONFIRMED') || codes.includes('UNIT_MISSING') ? '単位未確認：原文・依頼元に単位を確認してください。'
        : '情報不足：確定できる情報を抽出できていません。未記載か抽出漏れか、業務上必要かを確認してください。';
      return { field_name: key, reason, severity: 'warning' };
    });
}

export function checkQuantityUnit(output) {
  output.warnings_and_holds = output.warnings_and_holds.filter(w => w.code !== 'UNIT_MISSING');
  if (output.extracted_fields.quantity.value !== null && output.extracted_fields.quantity_unit.value === null)
    output.warnings_and_holds.push(warning('UNIT_MISSING', '数量はありますが、単位が未確認です。単位を推測せず確認してください。', 'quantity_unit'));
}

export function assertOutput(output) {
  if (!matchesSchema(output, OUTPUT_SCHEMA)) throw new ExtractionError('OUTPUT_SCHEMA_INVALID', '内部の出力検証に失敗しました。処理を停止しました。', 500);
}
