import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { FIELD_LABELS } from './extraction-schema.mjs';
import { ExtractionError } from './extraction.mjs';
import { auditIdentity } from './request-context.mjs';

export const BUSINESS_VERSION = 'business-review-1.0';
export const TOPICS = Object.freeze({ ...FIELD_LABELS, product_identity: '商品・適用仕様の特定', prior_reference: '前回案件・変更有無' });
export const REVIEW_STATES = Object.freeze({ unresolved: '未確認', awaiting_reply: '回答待ち', resolved: '解消済み（記録）', not_required: '今回不要（理由あり）' });
const fail = message => { throw new ExtractionError('BUSINESS_REVIEW_INVALID', message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, required = allowed) {
  if (!isObject(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('確認記録の項目・形式が一致しません。');
}
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}を入力してください（最大${max}文字）。`);
  return value.trim();
}
export function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !validDay(value.slice(0, 10))) return false;
  const h = Number(value.slice(11, 13)), m = Number(value.slice(14, 16));
  return h < 24 && m < 60 && (!value.slice(16).startsWith(':') || Number(value.slice(17, 19)) < 60) && Number.isFinite(Date.parse(value));
}
export function emptyBusiness(output) {
  return { version: BUSINESS_VERSION, answers: [], resolutions: Object.fromEntries(Object.keys(TOPICS).map(k => [k, { status: 'unresolved', reason: '', evidence_ids: [] }])),
    delivery: { kind: output.extracted_fields.requested_delivery_date.value ? 'date' : 'unknown', start: null, end: null },
    saved_at: null, recorded_by: null, identity_mode: auditIdentity().identity_mode };
}

// Separate from the model output: external AI neither reads nor writes these records.
// Answers are append-only. Corrections are new answers with an explicit explanation.
export function prepareBusiness(record, output, changes, submitted, now = new Date()) {
  const previous = record.business_review || emptyBusiness(record.output_payload);
  const result = structuredClone(previous);
  let provided = submitted !== undefined;
  if (provided) {
    keys(submitted, ['version', 'recorder', 'new_answer', 'resolutions', 'delivery']);
    if (submitted.version !== BUSINESS_VERSION) fail('確認記録の版が一致しません。画面を読み直してください。');
    result.recorded_by = text(submitted.recorder, '記録者名', 100);
    keys(submitted.resolutions, Object.keys(TOPICS));
    result.resolutions = structuredClone(submitted.resolutions);
    result.delivery = structuredClone(submitted.delivery);
    if (submitted.new_answer !== null) {
      keys(submitted.new_answer, ['respondent', 'responded_at', 'reference', 'text']);
      if (result.answers.length >= 100) fail('回答記録は1案件100件までです。管理者に確認してください。');
      const a = submitted.new_answer;
      if (!validTime(a.responded_at) || Date.parse(a.responded_at) > now.getTime()) fail('回答日時は未来でない、タイムゾーン付きの日時にしてください。');
      if (Date.parse(a.responded_at) < Date.parse(record.input_payload.received_at)) fail('回答日時は受付日時以降にしてください。過去資料の作成日は根拠資料欄へ記録してください。');
      const answer = { id: randomUUID(), respondent: text(a.respondent, '回答者・役割', 200), responded_at: a.responded_at,
        reference: text(a.reference, '根拠資料・参照番号', 1000), text: text(a.text, '回答原文・確認内容', 5000),
        recorded_by: result.recorded_by, recorded_at: now.toISOString(), identity_mode: auditIdentity().identity_mode };
      result.answers.push(answer);
      // Client token permits linking a just-added answer atomically with the review.
      for (const resolution of Object.values(result.resolutions)) {
        if (Array.isArray(resolution?.evidence_ids)) resolution.evidence_ids = resolution.evidence_ids.map(id => id === '__new__' ? answer.id : id);
      }
    }
  } else {
    // Legacy value-only clients must not silently retain a resolution after editing.
    const day = output.extracted_fields.requested_delivery_date.value;
    if (day !== record.output_payload.extracted_fields.requested_delivery_date.value) result.delivery = { kind: day ? 'date' : 'unknown', start: null, end: null };
  }
  keys(result.delivery, ['kind', 'start', 'end']);
  const { kind, start, end } = result.delivery;
  const day = output.extracted_fields.requested_delivery_date.value;
  if (!['unknown', 'date', 'window'].includes(kind)) fail('希望納期の形式を選択してください。');
  if (kind === 'window') {
    if (!validDay(start) || !validDay(end) || start > end || start < record.input_payload.received_at.slice(0, 10)) fail('希望期間の開始日・終了日・前後関係を確認してください。受付日より前の期間は保存できません。');
    if (day !== null) fail('希望期間と単一日の希望納期は同時に保存できません。単一日を空欄にしてください。');
  } else {
    if (start !== null || end !== null || (kind === 'date' ? !validDay(day) : day !== null)) fail('希望納期の形式と入力値が一致しません。');
  }
  const affected = new Set(changes.map(c => c.field_name));
  if (!isDeepStrictEqual(result.delivery, previous.delivery)) affected.add('requested_delivery_date');
  if (changes.some(c => ['customer_name', 'product_name', 'product_code', 'material', 'dimensions', 'tolerance'].includes(c.field_name))) affected.add('product_identity');
  if (changes.some(c => ['product_name', 'product_code', 'material', 'dimensions', 'tolerance'].includes(c.field_name))) affected.add('prior_reference');
  const reopened = [];
  const ids = new Set(result.answers.map(a => a.id));
  for (const [topic, resolution] of Object.entries(result.resolutions)) {
    keys(resolution, ['status', 'reason', 'evidence_ids']);
    if (!Object.hasOwn(REVIEW_STATES, resolution.status)) fail(`${TOPICS[topic]}の状態が不正です。`);
    resolution.reason = text(resolution.reason, `${TOPICS[topic]}の判断理由`, 1000, false);
    if (!Array.isArray(resolution.evidence_ids) || resolution.evidence_ids.length > 100 || new Set(resolution.evidence_ids).size !== resolution.evidence_ids.length || resolution.evidence_ids.some(id => typeof id !== 'string' || !ids.has(id))) fail(`${TOPICS[topic]}の回答根拠を確認してください。`);
    if (affected.has(topic) && ['resolved', 'not_required'].includes(previous.resolutions[topic].status)
      && isDeepStrictEqual(resolution, previous.resolutions[topic])) {
      resolution.status = 'unresolved';
      resolution.reason = `値または希望期間を変更したため再確認が必要です。以前の理由: ${resolution.reason}`.slice(0, 1000);
      reopened.push(topic);
    }
    if (['resolved', 'not_required'].includes(resolution.status)) {
      if (!resolution.reason || !resolution.evidence_ids.length) fail(`${TOPICS[topic]}を解消済み・今回不要にするには、判断理由と回答根拠が必要です。`);
      if (resolution.status === 'resolved' && Object.hasOwn(FIELD_LABELS, topic)
        && output.extracted_fields[topic].value === null && !(topic === 'requested_delivery_date' && kind === 'window')) fail(`${TOPICS[topic]}が空欄のままです。補足するか、不要の根拠を記録してください。`);
      if (resolution.status === 'not_required') {
        if (['customer_name', 'quantity', 'quantity_unit', 'product_identity'].includes(topic)) fail(`${TOPICS[topic]}は今回不要にできません。未確認・回答待ちで管理してください。`);
        if (Object.hasOwn(FIELD_LABELS, topic) && (output.extracted_fields[topic].value !== null || (topic === 'requested_delivery_date' && kind === 'window'))) fail(`${TOPICS[topic]}に値があります。今回不要ではなく確認状態を選んでください。`);
      }
    }
    if (resolution.status === 'awaiting_reply' && !resolution.reason) fail(`${TOPICS[topic]}の確認先・確認事項を判断理由へ記入してください。`);
  }
  result.saved_at = now.toISOString();
  return { business: result, reopened };
}
