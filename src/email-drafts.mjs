import { ExtractionError } from './extraction.mjs';

export const DRAFT_SCHEMA_VERSION = 'email-draft-1.2';
export const DRAFT_PROMPT_VERSION = 'email-draft-prompt-1.2';
export const DRAFT_TYPES = Object.freeze({
  customer_inquiry: { label: '顧客への不足情報確認', purpose: '不足・曖昧な条件を確認する', audience: 'customer' },
  internal_review: { label: '社内への確認依頼', purpose: '技術・購買・管理職へ判断を依頼する', audience: 'internal' },
  quote_notice: { label: '顧客への見積回答予告', purpose: '正式見積・納期は確認後に連絡すると伝える', audience: 'customer' }
});
const RECIPIENT_ROLES = Object.freeze({
  customer: ['顧客担当者'],
  internal: ['技術担当者', '購買・外注担当者', '管理職']
});
const INTERNAL_RECIPIENT_LINES = Object.freeze({
  技術担当者: '技術担当の方へ',
  '購買・外注担当者': '購買・外注担当の方へ',
  管理職: '管理職の方へ'
});

const PLACEHOLDERS = Object.freeze({ customer: '[顧客名]', product: '[品名・品番]', request: '[案件番号]',
  customerReference: '[顧客向け問い合わせ番号・元メール件名]', sender: '[担当者名]' });
export const CUSTOMER_ACTION_SENTENCE = 'お手数をおかけしますが、以下の項目をご確認のうえ、ご回答くださいますようお願いいたします。';
export const CUSTOMER_FOLLOWUP_SENTENCE = 'ご回答内容を確認後、正式な見積金額および納期を改めてご連絡いたします。';
const PROHIBITED = [
  { code: 'PRICE_ASSERTION', pattern: /(?:\d[\d,]*\s*円|単価|見積金額).{0,18}(?:で(?:ご提供|販売|承ります)|に決定|で確定)/u, label: '価格の断定' },
  { code: 'DELIVERY_GUARANTEE', pattern: /(?:納品|お届け|出荷).{0,18}(?:いたします|できます|可能です|を保証)/u, label: '納期の確約' },
  { code: 'APPROVAL_FABRICATION', pattern: /(?:承認済み|承認されました)/u, label: '未確認の承認済み表現' },
  { code: 'FEASIBILITY_ASSERTION', pattern: /(?:製造|加工|対応).{0,12}(?:可能です|できます|問題ありません)/u, label: '未確認の製造可否断定' },
  { code: 'ATTACHMENT_FABRICATION', pattern: /(?:添付|同封)(?:いたします|しました|をご確認)/u, label: '存在確認のない添付表現' },
  { code: 'CUSTOMER_INTERNAL_DATA', pattern: /(?:粗利|原価|承認閾値|値引率)/u, label: '顧客向け文面への社内情報混入', customerOnly: true }
];

function text(value, max = 1000) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) throw new ExtractionError('DRAFT_INPUT_INVALID', '文面入力の形式または長さを確認してください。');
  return value.trim() || null;
}

export function validateDraftInput(body) {
  const keys = new Set(['draft_type','mode','recipient_role','missing_items','questions','customer_name','product_label','request_id','customer_reference','sender_name','consent']);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.has(k))
    || !Object.hasOwn(DRAFT_TYPES, body.draft_type) || !['local','gemini'].includes(body.mode))
    throw new ExtractionError('DRAFT_INPUT_INVALID', '文面の種類と生成方式を確認してください。');
  if (!Array.isArray(body.missing_items) || !Array.isArray(body.questions) || body.missing_items.length > 20 || body.questions.length > 20)
    throw new ExtractionError('DRAFT_INPUT_INVALID', '確認項目は20件以内の配列で指定してください。');
  const missing = body.missing_items.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => !['id','label'].includes(k)))
      throw new ExtractionError('DRAFT_INPUT_INVALID', `不足項目${i + 1}の形式を確認してください。`);
    const id = text(item.id, 80), label = text(item.label, 100);
    if (!id || !label) throw new ExtractionError('DRAFT_INPUT_INVALID', '不足項目のIDと表示名が必要です。');
    return { id, label };
  });
  const questions = body.questions.map(v => text(v, 300)).filter(Boolean);
  const data = { draft_type: body.draft_type, mode: body.mode, recipient_role: text(body.recipient_role, 100),
    missing_items: missing, questions, customer_name: text(body.customer_name, 200), product_label: text(body.product_label, 300),
    request_id: text(body.request_id, 100), customer_reference: text(body.customer_reference, 300),
    sender_name: text(body.sender_name, 100), consent: body.consent === true };
  if (!data.recipient_role) throw new ExtractionError('DRAFT_INPUT_INVALID', '宛先の役割を入力してください。');
  const audience = DRAFT_TYPES[data.draft_type].audience;
  if (!RECIPIENT_ROLES[audience].includes(data.recipient_role))
    throw new ExtractionError('DRAFT_RECIPIENT_MISMATCH', '文面の種類と宛先の役割が一致しません。');
  return data;
}

function lines(items) { return items.length ? items.map(item => `・${item}`).join('\n') : '・確認事項なし'; }

function structuredDraft(input, prose) {
  const items = input.missing_items.map(item => item.label);
  const questions = [...items, ...input.questions];
  if (input.draft_type === 'customer_inquiry') return {
    subject: `【確認のお願い】${PLACEHOLDERS.product}のお見積りについて`,
    body: `${PLACEHOLDERS.customer}\nご担当者様\n\nお世話になっております。${PLACEHOLDERS.sender}です。\n${prose.opening}\n対象商品：${PLACEHOLDERS.product}\n弊社案件番号：${PLACEHOLDERS.request}\nお客様の問い合わせ番号・元メール件名：${PLACEHOLDERS.customerReference}\n\n${CUSTOMER_ACTION_SENTENCE}\n\n${lines(questions)}\n\n${CUSTOMER_FOLLOWUP_SENTENCE}\n${prose.closing}`,
    referenced_item_ids: input.missing_items.map(item => item.id)
  };
  if (input.draft_type === 'internal_review') return {
    subject: `【社内確認依頼】${PLACEHOLDERS.request} ${PLACEHOLDERS.product}`,
    body: `${INTERNAL_RECIPIENT_LINES[input.recipient_role]}\n\n${prose.opening}\n対象商品：${PLACEHOLDERS.product}\n案件番号：${PLACEHOLDERS.request}\n\n次の事項の確認をお願いします。\n\n${lines(questions)}\n\n価格・納期・承認要否は未確定です。確認根拠と判断結果を記録してください。\n${prose.closing}\n${PLACEHOLDERS.sender}`,
    referenced_item_ids: input.missing_items.map(item => item.id)
  };
  return {
    subject: `【お見積り受付のご連絡】${PLACEHOLDERS.product}`,
    body: `${PLACEHOLDERS.customer}\nご担当者様\n\nお世話になっております。${PLACEHOLDERS.sender}です。\n${prose.opening}\n対象商品：${PLACEHOLDERS.product}\n弊社案件番号：${PLACEHOLDERS.request}\nお客様の問い合わせ番号・元メール件名：${PLACEHOLDERS.customerReference}\n正式な見積金額および納期については、社内確認の上、改めてご連絡いたします。\n\n${prose.closing}`,
    referenced_item_ids: input.missing_items.map(item => item.id)
  };
}

export function localTemplate(input) {
  return structuredDraft(input, {
    opening: input.draft_type === 'internal_review' ? '見積条件の確認をお願いします。' : 'お見積り内容の確認についてご連絡いたしました。',
    closing: input.draft_type === 'internal_review' ? 'よろしくお願いします。' : '何卒よろしくお願いいたします。'
  });
}

export function composeGeminiDraft(fragment, input) {
  return structuredDraft(input, fragment);
}

export function externalPreview(input) {
  return {
    draft_type: input.draft_type,
    purpose: DRAFT_TYPES[input.draft_type].purpose,
    recipient_role: input.recipient_role,
    requested_output: ['匿名の導入文', '匿名の結び文'],
    missing_item_count: input.missing_items.length,
    additional_question_count: input.questions.length,
    constraints: ['価格を断定しない', '納期を確約しない', '自動送信しない', '不足情報を創作しない'],
    local_insertion_fields: ['顧客名', '商品情報', '弊社案件番号', '顧客向け問い合わせ番号・元メール件名', '自社担当者', '不足項目', '追加確認事項'],
    note: '顧客名・商品名・品番・案件番号・顧客向け問い合わせ番号・元メール件名・担当者名・不足項目名・追加質問・図面番号・価格・原価・依頼原文・メールアドレスは含めない。これらは応答後にサーバー内で組み込む'
  };
}

export function hydrateDraft(draft, input) {
  const replacements = { [PLACEHOLDERS.customer]: input.customer_name || PLACEHOLDERS.customer,
    [PLACEHOLDERS.product]: input.product_label || PLACEHOLDERS.product,
    [PLACEHOLDERS.request]: input.request_id || PLACEHOLDERS.request,
    [PLACEHOLDERS.customerReference]: input.customer_reference || PLACEHOLDERS.customerReference,
    [PLACEHOLDERS.sender]: input.sender_name || PLACEHOLDERS.sender };
  let subject = draft.subject, body = draft.body;
  for (const [placeholder, value] of Object.entries(replacements)) {
    subject = subject.split(placeholder).join(value); body = body.split(placeholder).join(value);
  }
  return { subject, body, referenced_item_ids: draft.referenced_item_ids };
}

export function checkDraftQuality(draft, input) {
  const full = `${draft.subject}\n${draft.body}`;
  const audience = DRAFT_TYPES[input.draft_type].audience;
  const violations = PROHIBITED.filter(rule => (!rule.customerOnly || audience === 'customer') && rule.pattern.test(full))
    .map(rule => ({ code: rule.code, message: `${rule.label}が含まれています。` }));
  const expected = [...new Set(input.missing_items.map(item => item.id))].sort();
  const actual = [...new Set(Array.isArray(draft.referenced_item_ids) ? draft.referenced_item_ids : [])].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) violations.push({ code: 'MISSING_ITEMS_MISMATCH', message: '不足項目の列挙が入力と一致しません。' });
  const absentLabels = input.missing_items.filter(item => !draft.body.includes(item.label)).map(item => item.label);
  if (absentLabels.length) violations.push({ code: 'MISSING_ITEMS_TEXT_ABSENT', message: `本文に不足項目がありません：${absentLabels.join('、')}` });
  const absentQuestions = input.questions.filter(question => !draft.body.includes(question));
  if (absentQuestions.length) violations.push({ code: 'QUESTIONS_TEXT_ABSENT', message: '本文に追加確認事項がすべて含まれていません。' });
  const requiredSources = [
    ...(audience === 'customer' ? [
      { key: 'customer_name', label: '顧客名', value: input.customer_name },
      { key: 'customer_reference', label: '顧客向け問い合わせ番号・元メール件名', value: input.customer_reference }
    ] : []),
    { key: 'product_label', label: '商品情報', value: input.product_label },
    { key: 'request_id', label: '案件番号', value: input.request_id },
    { key: 'sender_name', label: '自社担当者', value: input.sender_name }
  ];
  for (const source of requiredSources) {
    if (!source.value) violations.push({ code: `SOURCE_INPUT_MISSING_${source.key.toUpperCase()}`, item: source.label,
      message: `必須の${source.label}が入力されていません。` });
    else if (!full.includes(source.value)) violations.push({ code: `SOURCE_VALUE_MISSING_${source.key.toUpperCase()}`, item: source.label,
      message: `${source.label}が本文または件名から欠落しています。` });
  }
  if (input.draft_type === 'customer_inquiry' && !draft.body.includes(CUSTOMER_ACTION_SENTENCE))
    violations.push({ code: 'CUSTOMER_ACTION_GUIDANCE_MISSING', item: '顧客への依頼文', message: '顧客への回答依頼文が欠落しています。' });
  if (input.draft_type === 'customer_inquiry' && !draft.body.includes(CUSTOMER_FOLLOWUP_SENTENCE))
    violations.push({ code: 'CUSTOMER_FOLLOWUP_GUIDANCE_MISSING', item: '回答後の自社対応文', message: '回答後の自社対応文が欠落しています。' });
  if (input.mode === 'gemini' && /\d[\d,]*\s*円/u.test(full))
    violations.push({ code: 'UNVERIFIED_PRICE_VALUE', message: 'AIへ価格を渡していないのに金額表現が生成されています。' });
  if (!draft.subject || !draft.body || draft.subject.length > 150 || draft.body.length > 3000)
    violations.push({ code: 'LENGTH_INVALID', message: '件名・本文の長さが基準外です。' });
  if (audience === 'customer' && !/(ご担当者様|様)/u.test(draft.body))
    violations.push({ code: 'AUDIENCE_MISMATCH', message: '顧客向けの宛名が確認できません。' });
  if (audience === 'internal' && !draft.body.includes(INTERNAL_RECIPIENT_LINES[input.recipient_role]))
    violations.push({ code: 'AUDIENCE_MISMATCH', message: '社内向けの書き分けが確認できません。' });
  return { passed: violations.length === 0, violations, checks: {
    prohibited_expressions_absent: !violations.some(v => ['PRICE_ASSERTION','DELIVERY_GUARANTEE','APPROVAL_FABRICATION','FEASIBILITY_ASSERTION','ATTACHMENT_FABRICATION','CUSTOMER_INTERNAL_DATA'].includes(v.code)),
    source_consistency: !violations.some(v => v.code.startsWith('SOURCE_') || v.code === 'UNVERIFIED_PRICE_VALUE'),
    audience_appropriate: !violations.some(v => v.code === 'AUDIENCE_MISMATCH'),
    missing_items_complete: !violations.some(v => ['MISSING_ITEMS_MISMATCH','MISSING_ITEMS_TEXT_ABSENT','QUESTIONS_TEXT_ABSENT'].includes(v.code)),
    business_style_and_length: !violations.some(v => v.code === 'LENGTH_INVALID'),
    auto_send: false
  }};
}

export async function geminiDraft({ preview, ai, fetchFn = fetch, timeoutMs = 30_000 }) {
  if (!ai.apiKey) throw new ExtractionError('AI_KEY_MISSING', 'GeminiのAPIキーが未設定です。外部送信していません。', 503);
  let response;
  try {
    response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': ai.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'あなたは日本語の業務メール文面支援です。個別案件情報、固有名詞、品番、案件番号、担当者名、価格、日付、確認項目、プレースホルダーを一切含めず、匿名の短い導入文と結び文だけを生成してください。価格を断定せず、納期を確約せず、情報を創作しないでください。必須情報と確認項目は応答後にローカル処理で追加します。出力は指定JSONのみです。' }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(preview) }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object', additionalProperties: false,
          required: ['opening','closing'], properties: { opening: { type: 'string' }, closing: { type: 'string' } } }, maxOutputTokens: 512 }
      })
    });
    if (!response.ok) throw new ExtractionError('AI_HTTP_ERROR', `GeminiからHTTP ${response.status}が返りました。再試行はしていません。`, 502);
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw new ExtractionError('AI_INCOMPLETE', 'AI応答が正常完了していません。途中の文面は採用しません。', 502);
    return JSON.parse((candidate.content?.parts || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join(''));
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError('AI_RESPONSE_ERROR', 'AIとの通信またはJSONの読み取りに失敗しました。再試行せず停止しました。', 502);
  }
}
