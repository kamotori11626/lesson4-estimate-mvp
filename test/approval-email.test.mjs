import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateApproval, APPROVAL_RULE_VERSION } from '../src/approval-rules.mjs';
import { checkDraftQuality, CUSTOMER_ACTION_SENTENCE, CUSTOMER_FOLLOWUP_SENTENCE, externalPreview,
  geminiDraft, hydrateDraft, localTemplate, validateDraftInput } from '../src/email-drafts.mjs';
import { createApprovalEmailService } from '../src/approval-email-service.mjs';

function extraction(overrides = {}) {
  return { revision: 2, input_payload: { case_type: '規格品' }, output_payload: { request_id: '11111111-1111-4111-8111-111111111111',
    status: 'needs_review', warnings_and_holds: [], missing_fields: [], extracted_fields: {
      customer_name: { value: '保存顧客' }, product_code: { value: 'SAVE-01' }, product_name: { value: '保存製品' }
    } }, ...overrides };
}
function input(overrides = {}) {
  return { planned_price: 10000, cost: 7000, list_price: 10000, required_tech_review: false,
    required_supplier_quote: false, route_basis: '', acknowledged: true, ...overrides };
}
function reviewedSearch(revision = 2) {
  return { run_id: '33333333-3333-4333-8333-333333333333', extraction_revision: revision,
    status: 'reviewed', price_analysis: { status: 'within_threshold', severity: 'none' } };
}

test('粗利率の18%・20%境界と値引率をサーバー側計算で判定する', () => {
  assert.equal(evaluateApproval({ extraction: extraction(), rawInput: input({ cost: 8201 }) }).status, 'required');
  assert.equal(evaluateApproval({ extraction: extraction(), rawInput: input({ cost: 8200 }) }).status, 'hold');
  assert.equal(evaluateApproval({ extraction: extraction(), rawInput: input({ cost: 8001 }) }).status, 'hold');
  const ok = evaluateApproval({ extraction: extraction(), rawInput: input({ cost: 8000 }) });
  assert.equal(ok.status, 'not_required');
  assert.equal(ok.reason, null);
  assert.equal(ok.extraction_revision, 2);
  assert.equal(ok.rule_version, APPROVAL_RULE_VERSION);
  assert.equal(evaluateApproval({ extraction: extraction(), rawInput: input({ list_price: 11000 }) }).status, 'hold');
});

test('未確定情報・MVP対象外・価格比較不能は安全側で保留する', () => {
  const missing = extraction(); missing.output_payload.missing_fields = [{ field_name: 'material' }];
  assert.equal(evaluateApproval({ extraction: missing, rawInput: input() }).status, 'hold');
  const custom = extraction(); custom.input_payload.case_type = '新規特注';
  assert.equal(evaluateApproval({ extraction: custom, rawInput: input() }).status, 'hold');
  assert.equal(evaluateApproval({ extraction: extraction(), priceAnalysis: { status: 'comparison_unavailable' }, rawInput: input() }).status, 'hold');
  const processPending = evaluateApproval({ extraction: extraction(), priceAnalysis: { status: 'not_executed_process_type' }, rawInput: input() });
  assert.equal(processPending.status, 'hold');
  assert.deepEqual(processPending.approver_roles, ['技術担当']);
  assert.ok(processPending.rule_results.some(rule => rule.rule_id === 'PROCESS-001'));
  assert.equal(evaluateApproval({ extraction: extraction({ revision: 1 }), rawInput: input() }).status, 'hold');
});

test('技術確認・外注見積は根拠なしでは受け付けず、根拠付きなら確認先を返す', () => {
  assert.throws(() => evaluateApproval({ extraction: extraction(), rawInput: input({ required_tech_review: true }) }), /理由/);
  const result = evaluateApproval({ extraction: extraction(), rawInput: input({ required_tech_review: true, route_basis: '図面公差の確認が必要' }) });
  assert.equal(result.status, 'required');
  assert.deepEqual(result.approver_roles, ['技術担当']);
});

test('ローカル定型文は不足項目を網羅し、価格断定・納期確約・自動送信をしない', () => {
  const data = validateDraftInput({ draft_type: 'customer_inquiry', mode: 'local', recipient_role: '顧客担当者',
    missing_items: [{ id: 'tolerance', label: '公差' }], questions: ['図面の版をご教示ください'],
    customer_name: 'テスト株式会社', product_label: 'TEST-01', request_id: 'RFQ-TEST',
    customer_reference: '元メール件名「TEST-01見積依頼」', sender_name: '営業担当', consent: false });
  const draft = hydrateDraft(localTemplate(data), data);
  const quality = checkDraftQuality(draft, data);
  assert.equal(quality.passed, true);
  assert.equal(quality.checks.auto_send, false);
  for (const value of ['テスト株式会社','TEST-01','RFQ-TEST','元メール件名「TEST-01見積依頼」','営業担当','公差','図面の版をご教示ください'])
    assert.match(`${draft.subject}\n${draft.body}`, new RegExp(value));
  assert.match(draft.body, new RegExp(CUSTOMER_ACTION_SENTENCE));
  assert.match(draft.body, new RegExp(CUSTOMER_FOLLOWUP_SENTENCE));
  assert.match(draft.body, /^テスト株式会社\nご担当者様\n/u);
});

test('社内確認メールは役割別に自然な宛名を使い、担当者を重複させない', () => {
  const cases = [
    ['技術担当者', '技術担当の方へ'],
    ['購買・外注担当者', '購買・外注担当の方へ'],
    ['管理職', '管理職の方へ']
  ];
  for (const [recipientRole, expectedLine] of cases) {
    const data = validateDraftInput({ draft_type: 'internal_review', mode: 'local', recipient_role: recipientRole,
      missing_items: [{ id: 'tolerance', label: '公差' }], questions: ['適用図面をご確認ください'],
      customer_name: null, product_label: 'TEST-01', request_id: 'RFQ-TEST', customer_reference: null,
      sender_name: '営業担当', consent: false });
    const draft = hydrateDraft(localTemplate(data), data);
    assert.match(draft.body, new RegExp(`^${expectedLine}\\n\\n`, 'u'));
    assert.doesNotMatch(draft.body, /担当者\s+ご担当者様/u);
    assert.equal(checkDraftQuality(draft, data).passed, true);
  }
});

test('外部AI向けプレビューから顧客名・品番・価格・原文を除外する', () => {
  const data = validateDraftInput({ draft_type: 'internal_review', mode: 'gemini', recipient_role: '技術担当者',
    missing_items: [{ id: 'material', label: '材質' }], questions: ['秘密顧客のSECRET-99を確認'],
    customer_name: '秘密顧客', product_label: 'SECRET-99', request_id: 'SECRET-RFQ',
    customer_reference: 'SECRET-SUBJECT', sender_name: '秘密担当', consent: true });
  const serialized = JSON.stringify(externalPreview(data));
  for (const secret of ['秘密顧客','SECRET-99','SECRET-RFQ','SECRET-SUBJECT','秘密担当','材質']) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('[顧客名]'), false);
  assert.equal(serialized.includes('missing_item_count'), true);
});

test('Gemini文面は固定JSONで1回だけ呼び、再試行しない', async () => {
  let calls = 0; let sent = '';
  const fetchFn = async (_url, options) => { calls += 1; sent = options.body; return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ opening: 'お見積り内容の確認についてご連絡いたしました。', closing: '何卒よろしくお願いいたします。' }) }] } }] }) }; };
  const result = await geminiDraft({ preview: { missing_item_count: 1 }, ai: { apiKey: 'dummy', model: 'test-model' }, fetchFn });
  assert.equal(calls, 1);
  assert.match(result.opening, /確認/);
  assert.match(sent, /responseJsonSchema/);
  assert.doesNotMatch(sent, /referenced_item_ids|\[顧客名\]/);
});

test('禁止表現と不足項目の欠落は機械検査で不合格にする', () => {
  const data = validateDraftInput({ draft_type: 'customer_inquiry', mode: 'local', recipient_role: '顧客担当者',
    missing_items: [{ id: 'quantity', label: '数量' }], questions: [], customer_name: null, product_label: null,
    request_id: null, customer_reference: null, sender_name: null, consent: false });
  const quality = checkDraftQuality({ subject: '見積', body: 'ご担当者様 10,000円でご提供します。明日納品いたします。', referenced_item_ids: [] }, data);
  assert.equal(quality.passed, false);
  const codes = quality.violations.map(v => v.code);
  for (const code of ['DELIVERY_GUARANTEE','MISSING_ITEMS_MISMATCH','MISSING_ITEMS_TEXT_ABSENT','PRICE_ASSERTION',
    'SOURCE_INPUT_MISSING_CUSTOMER_NAME','SOURCE_INPUT_MISSING_CUSTOMER_REFERENCE','SOURCE_INPUT_MISSING_PRODUCT_LABEL','SOURCE_INPUT_MISSING_REQUEST_ID','SOURCE_INPUT_MISSING_SENDER_NAME',
    'CUSTOMER_ACTION_GUIDANCE_MISSING','CUSTOMER_FOLLOWUP_GUIDANCE_MISSING']) assert.ok(codes.includes(code));
  assert.deepEqual(quality.violations.filter(v => v.code.startsWith('SOURCE_INPUT_MISSING_')).map(v => v.item).sort(),
    ['商品情報','案件番号','自社担当者','顧客名','顧客向け問い合わせ番号・元メール件名'].sort());
});

test('必須情報の欠落は顧客名・商品情報・案件番号・顧客向け識別情報・自社担当者を個別表示する', () => {
  const data = validateDraftInput({ draft_type: 'customer_inquiry', mode: 'gemini', recipient_role: '顧客担当者',
    missing_items: [{ id: 'material', label: '材質' }], questions: [], customer_name: 'テスト顧客',
    product_label: 'TEST-01 / テスト商品', request_id: 'RFQ-TEST-01',
    customer_reference: '元メール件名「テスト商品の見積依頼」', sender_name: '営業担当', consent: true });
  const complete = hydrateDraft(localTemplate(data), data);
  const cases = [
    ['顧客名', 'テスト顧客'], ['商品情報', 'TEST-01 / テスト商品'],
    ['案件番号', 'RFQ-TEST-01'], ['顧客向け問い合わせ番号・元メール件名', '元メール件名「テスト商品の見積依頼」'],
    ['自社担当者', '営業担当']
  ];
  for (const [label, value] of cases) {
    const broken = { ...complete, subject: complete.subject.split(value).join(''), body: complete.body.split(value).join('') };
    const quality = checkDraftQuality(broken, data);
    assert.equal(quality.passed, false);
    assert.ok(quality.violations.some(v => v.item === label && v.message.includes(label)));
  }
});

test('模擬Geminiがプレースホルダーと必須文を返さなくてもローカル処理で顧客確認文を完成させる', async () => {
  const runs = new Map(), drafts = []; let calls = 0; let sent = '';
  const missingExtraction = extraction();
  missingExtraction.output_payload.missing_fields = [
    { field_name: 'material' }, { field_name: 'tolerance' }, { field_name: 'dimensions' }, { field_name: 'product_code' }
  ];
  missingExtraction.output_payload.extracted_fields = {
    customer_name: { value: '検証用顧客B' }, product_code: { value: null }, product_name: { value: 'PPSカバー80' }
  };
  const store = {
    async create(run) { runs.set(run.run_id, { run_id: run.run_id, extraction_run_id: run.extraction_run_id,
      request_id: run.request_id, input_payload: run.input, approval_result: run.approval,
      rule_version: run.approval.rule_version, status: run.approval.status, created_at: new Date() }); },
    async get(id) { return runs.get(id) || null; }, async latest() { return null; }, async drafts() { return drafts; },
    async saveDraft(runId, d) { const row = { ...d, run_id: runId, draft_payload: d.payload, quality_result: d.quality,
      created_at: new Date(), updated_at: new Date(), revision: 1 }; drafts.push(row); return row; }
  };
  const fetchFn = async (_url, options) => { calls += 1; sent = options.body; return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    opening: 'お見積り内容を正確に確認するため、ご連絡いたしました。', closing: '何卒よろしくお願いいたします。'
  }) }] } }] }) }; };
  const service = createApprovalEmailService({ extractionStore: { async get() { return missingExtraction; } },
    similarSearch: { async latest() { return reviewedSearch(); } }, store,
    ai: { provider: 'gemini', apiKey: 'dummy', model: 'test-model' }, fetchFn });
  const run = await service.evaluate('22222222-2222-4222-8222-222222222222', input());
  const draftRequest = { draft_type: 'customer_inquiry', mode: 'gemini', recipient_role: '顧客担当者',
    missing_items: [], questions: [], customer_name: '偽入力', product_label: '偽商品', request_id: '偽案件',
    customer_reference: '元メール件名「PPSカバー80の見積依頼」', sender_name: '営業担当', consent: true };
  await assert.rejects(() => service.draft(run.run_id, { ...draftRequest, customer_reference: null }), /問い合わせ番号または元メール件名/);
  assert.equal(calls, 0);
  const shown = await service.preview(run.run_id, draftRequest);
  assert.equal(shown.security.external_ai_calls, 0);
  assert.equal(shown.security.consent_recorded, false);
  const made = await service.draft(run.run_id, draftRequest);
  assert.equal(calls, 1);
  assert.equal(made.quality.passed, true);
  assert.equal(made.generation_method, 'gemini_sanitized');
  assert.equal(made.security.auto_send, false);
  for (const value of ['検証用顧客B','PPSカバー80','11111111-1111-4111-8111-111111111111','元メール件名「PPSカバー80の見積依頼」','営業担当','材質','公差','寸法','品番',
    CUSTOMER_ACTION_SENTENCE,CUSTOMER_FOLLOWUP_SENTENCE]) assert.ok(`${made.draft.subject}\n${made.draft.body}`.includes(value));
  for (const secret of ['検証用顧客B','PPSカバー80','11111111-1111-4111-8111-111111111111','元メール件名「PPSカバー80の見積依頼」','営業担当','偽入力'])
    assert.equal(sent.includes(secret), false);
  const sentPreview = JSON.parse(JSON.parse(sent).contents[0].parts[0].text);
  assert.deepEqual(sentPreview, shown.preview);
  assert.equal(Object.hasOwn(sentPreview, 'missing_items'), false);
  assert.equal(sentPreview.missing_item_count, 4);
  for (const missingLabel of ['材質','公差','寸法']) assert.equal(JSON.stringify(sentPreview).includes(missingLabel), false);
  assert.equal(drafts.length, 1);
});

test('サービスは承認判定・下書きを保存するが送信経路を返さない', async () => {
  const runs = new Map(), drafts = [];
  const store = {
    async create(run) { runs.set(run.run_id, { run_id: run.run_id, extraction_run_id: run.extraction_run_id, request_id: run.request_id,
      input_payload: run.input, approval_result: run.approval, rule_version: run.approval.rule_version, status: run.approval.status, created_at: new Date() }); },
    async get(id) { return runs.get(id) || null; }, async latest() { return null; }, async drafts() { return drafts; },
    async saveDraft(runId, d) { const row = { ...d, run_id: runId, draft_payload: d.payload, quality_result: d.quality,
      created_at: new Date(), updated_at: new Date(), revision: 1 }; drafts.push(row); return row; },
    async getDraft(runId, draftId) { return drafts.find(d => d.run_id === runId && d.draft_id === draftId) || null; }
  };
  const service = createApprovalEmailService({ extractionStore: { async get() { return extraction(); } },
    similarSearch: { async latest() { return reviewedSearch(); } }, store, ai: { provider: 'gemini', apiKey: '', model: 'test' } });
  const run = await service.evaluate('22222222-2222-4222-8222-222222222222', input());
  assert.equal(run.security.auto_send, false);
  const made = await service.draft(run.run_id, { draft_type: 'quote_notice', mode: 'local', recipient_role: '顧客担当者', missing_items: [], questions: [],
    customer_name: '顧客A', product_label: '製品A', request_id: 'RFQ-A', customer_reference: 'お客様番号 C-001', sender_name: '担当A', consent: false });
  assert.equal(made.security.send_endpoint, false);
  assert.match(made.draft.body, /保存顧客/);
  assert.match(made.draft.subject, /SAVE-01/);
  assert.doesNotMatch(made.draft.body, /顧客A/);
  assert.equal(drafts.length, 1);
});

test('承認判定後に抽出結果の版が変わった場合は下書きを生成しない', async () => {
  const runs = new Map();
  let currentExtraction = extraction();
  const store = {
    async create(run) { runs.set(run.run_id, { run_id: run.run_id, extraction_run_id: run.extraction_run_id,
      request_id: run.request_id, input_payload: run.input, approval_result: run.approval,
      rule_version: run.approval.rule_version, status: run.approval.status, created_at: new Date() }); },
    async get(id) { return runs.get(id) || null; }, async latest() { return null; }, async drafts() { return []; }
  };
  const service = createApprovalEmailService({ extractionStore: { async get() { return currentExtraction; } },
    similarSearch: { async latest() { return reviewedSearch(2); } }, store, ai: { provider: 'gemini', apiKey: '', model: 'test' } });
  const run = await service.evaluate('22222222-2222-4222-8222-222222222222', input());
  currentExtraction = extraction({ revision: 3 });
  await assert.rejects(() => service.draft(run.run_id, { draft_type: 'quote_notice', mode: 'local',
    recipient_role: '顧客担当者', missing_items: [], questions: [], customer_name: null, product_label: null,
    request_id: null, customer_reference: '元メール件名「見積依頼」', sender_name: null, consent: false }), /最新の抽出結果で承認要否を再判定/);
});

test('統合フローでは類似検索の人間判断前・旧抽出版・未実行の承認判定を拒否する', async () => {
  const source = extraction();
  const unusedStore = { async create() { throw new Error('呼ばれてはいけません'); } };
  for (const [latest, pattern] of [
    [null, /先に名寄せ・類似案件検索/],
    [{ ...reviewedSearch(), status: 'quote_review' }, /採用・却下理由を保存/],
    [reviewedSearch(1), /最新の抽出値でもう一度検索/]
  ]) {
    const service = createApprovalEmailService({ extractionStore: { async get() { return source; } },
      similarSearch: { async latest() { return latest; } }, store: unusedStore,
      ai: { provider: 'gemini', apiKey: '', model: 'test' } });
    await assert.rejects(() => service.evaluate('22222222-2222-4222-8222-222222222222', input()), pattern);
  }
});
