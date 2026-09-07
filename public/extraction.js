const $ = selector => document.querySelector(selector);
let config = null;
let current = null;
let currentSearch = null;
let searchConfig = null;
let currentProcessSuggestion = null;
let working = false;
const editable = {};
const resolutionInputs = {};
const stoppedCodes = ['MULTIPLE_ITEMS', 'OUT_OF_MVP', 'OUT_OF_SCOPE', 'ITEM_COUNT_UNCERTAIN', 'SCOPE_UNCERTAIN'];
function blocked() { return !current || current.output.status === 'error' || current.output.warnings_and_holds.some(w => stoppedCodes.includes(w.code)); }
const fieldInputs = { customer_name: '#ex-customer', received_at: '#ex-received', request_channel: '#ex-channel',
  case_type: '#ex-case', item_scope: '#ex-items', request_text: '#ex-text' };

function readInput() {
  return { schema_version: config.schema_version, ...Object.fromEntries(Object.entries(fieldInputs).map(([k, selector]) => [k, $(selector).value])),
    mode: $('#ex-mode').value, consent: $('#ex-consent').checked };
}
function message(text) { $('#ex-message').textContent = text; }
function updatePreview() {
  $('#ex-consent').checked = false;
  const external = $('#ex-mode').value === 'gemini';
  $('#ex-external').hidden = !external;
  if (!config) return;
  const input = readInput();
  const sample = config.samples.find(s => Object.keys(fieldInputs).every(k => s[k] === input[k]));
  $('#ex-send-preview').textContent = sample
    ? sample.request_text.split(sample.customer_name).join('[CUSTOMER]')
    : 'この入力は外部送信できません。用意された匿名サンプルの内容に戻してください。';
  $('#ex-consent').disabled = !sample || !config.gemini_configured;
}

function invalidateResult() {
  current = null;
  currentSearch = null;
  $('#ex-output').hidden = true;
  $('#ex-reviewed').checked = false;
  updatePreview();
}

function setBusy(value) {
  working = value;
  for (const el of $('#extraction-form').elements) el.disabled = value;
  $('#extraction-sample').disabled = value;
  $('#ex-save').disabled = value;
  $('#ex-reload').disabled = value;
  for (const el of Object.values(editable)) el.disabled = value;
  for (const el of $('#business-editor').querySelectorAll('input,select,textarea')) el.disabled = value;
  for (const el of $('#similar-search-panel').querySelectorAll('input,select,textarea,button')) el.disabled = value;
  if (!value) {
    updatePreview();
    $('#ex-mode option[value="gemini"]').disabled = !config?.gemini_configured;
    $('#ex-save').disabled = blocked();
    $('#ex-reviewed').disabled = blocked();
    for (const el of Object.values(editable)) el.disabled = blocked();
    for (const el of $('#business-editor').querySelectorAll('input,select,textarea')) el.disabled = blocked();
    setDeliveryInputs();
    $('#ex-reload').disabled = !current?.output.audit_log_id;
    $('#ss-start').disabled = blocked();
    $('#ss-quotes').disabled = !currentSearch || !currentSearch.entity_candidates?.products?.length || !processDecisionReady();
    $('#ss-save-decision').disabled = !currentSearch || !['quote_review', 'reviewed'].includes(currentSearch.status);
  }
}

async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok && !data.output) throw new Error(data.error || '処理に失敗しました。');
  return data;
}

function list(selector, texts) {
  const node = $(selector);
  node.replaceChildren();
  for (const text of texts) { const item = document.createElement('li'); item.textContent = text; node.append(item); }
}

function dirty() { $('#ex-reviewed').checked = false; }
function setDeliveryInputs() {
  const kind = $('#br-delivery-kind').value;
  $('#br-window').hidden = kind !== 'window';
  if (editable.requested_delivery_date) editable.requested_delivery_date.disabled = working || blocked() || kind !== 'date';
}
function dateTimeText(value) { return value ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST' : '記録なし'; }
function renderBusiness(data) {
  const business = data.business_review;
  if (!business || !config.review_topics) {
    $('#business-editor').hidden = true;
    $('#br-summary').textContent = 'サーバーを更新してから画面を読み直してください。';
    return;
  }
  $('#business-editor').hidden = false;
  $('#br-recorder').value = business.recorded_by || $('#br-recorder').value;
  for (const id of ['br-respondent', 'br-responded', 'br-reference', 'br-answer']) $('#' + id).value = '';
  $('#br-delivery-kind').value = business.delivery.kind;
  $('#br-start').value = business.delivery.start || '';
  $('#br-end').value = business.delivery.end || '';
  const topics = $('#br-resolutions'); topics.replaceChildren();
  for (const [key, title] of Object.entries(config.review_topics)) {
    const saved = business.resolutions[key];
    const box = document.createElement('fieldset'); box.className = 'review-topic';
    const legend = document.createElement('legend'); legend.textContent = title; box.append(legend);
    const grid = document.createElement('div'); grid.className = 'review-grid';
    const stateLabel = document.createElement('label'); stateLabel.textContent = '現在の状態';
    const state = document.createElement('select'); state.setAttribute('aria-label', `${title}の確認状態`);
    for (const [value, text] of Object.entries(config.review_states)) { const option = document.createElement('option'); option.value = value; option.textContent = text; state.append(option); }
    state.value = saved.status; stateLabel.append(state);
    const reasonLabel = document.createElement('label'); reasonLabel.textContent = '判断理由／確認先・確認事項';
    const reason = document.createElement('textarea'); reason.rows = 2; reason.maxLength = 1000;
    reason.setAttribute('aria-label', `${title}の判断理由`); reason.value = saved.reason; reasonLabel.append(reason);
    grid.append(stateLabel, reasonLabel); box.append(grid);
    const evidence = [];
    for (const answer of [...business.answers, { id: '__new__', respondent: '今回追加する回答', text: '' }]) {
      const label = document.createElement('label'); label.className = 'evidence-option';
      const check = document.createElement('input'); check.type = 'checkbox'; check.value = answer.id;
      check.checked = saved.evidence_ids.includes(answer.id);
      check.setAttribute('aria-label', `${title}の根拠：${answer.id === '__new__' ? '今回追加する回答' : answer.id}`);
      label.append(check, document.createTextNode(answer.id === '__new__' ? '今回追加する回答を根拠にする' : `${answer.respondent} / ${dateTimeText(answer.responded_at)} / ${answer.id.slice(0, 8)} / ${answer.text.slice(0, 60)}`));
      box.append(label); evidence.push(check);
    }
    for (const input of [state, reason, ...evidence]) input.addEventListener('input', dirty);
    resolutionInputs[key] = { state, reason, evidence }; topics.append(box);
  }
  const counts = Object.fromEntries(Object.keys(config.review_states).map(s => [s, Object.values(business.resolutions).filter(r => r.status === s).length]));
  $('#br-summary').textContent = `保存済み状態：${Object.entries(counts).map(([s, n]) => `${config.review_states[s]} ${n}件`).join(' / ')}。これは正式承認ではありません。`;
  const answers = $('#br-answers'); answers.replaceChildren();
  if (!business.answers.length) answers.textContent = '回答根拠はまだ登録されていません。';
  for (const a of business.answers) {
    const item = document.createElement('div'); item.className = 'answer-record';
    item.textContent = `回答ID: ${a.id}\n回答者・役割: ${a.respondent}\n回答確認日時: ${dateTimeText(a.responded_at)}\n根拠資料: ${a.reference}\n回答内容: ${a.text}\n記録者: ${a.recorded_by}（ログイン利用者） / 保存日時: ${dateTimeText(a.recorded_at)}`;
    answers.append(item);
  }
  const history = $('#br-history'); history.replaceChildren();
  if (!data.review_history?.length) history.textContent = '保存履歴はありません。';
  for (const h of data.review_history || []) {
    const detail = document.createElement('details'); const title = document.createElement('summary');
    title.textContent = `${dateTimeText(h.saved_at)} / ${h.business_review?.recorded_by || h.reviewer_id}（ログイン利用者） / 値の変更 ${h.changes.length}項目`;
    const body = document.createElement('pre'); body.className = 'result';
    body.textContent = JSON.stringify({ changes: h.changes, confirmation: h.business_review }, null, 2); detail.append(title, body); history.append(detail);
  }
  $('#br-initial').textContent = data.initial_output ? JSON.stringify(data.initial_output, null, 2) : 'この旧記録には初回値の独立スナップショットがありません。保存済みの原文引用・既存履歴は残っています。現在値から初回値を捏造していません。';
}

function readBusiness() {
  const hasAnswer = ['br-respondent', 'br-responded', 'br-reference', 'br-answer'].some(id => $('#' + id).value.trim());
  const kind = $('#br-delivery-kind').value;
  const localTime = $('#br-responded').value;
  return { version: config.business_version, recorder: $('#br-recorder').value.trim(),
    new_answer: hasAnswer ? { respondent: $('#br-respondent').value.trim(), responded_at: localTime ? `${localTime.length === 16 ? localTime + ':00' : localTime}+09:00` : '', reference: $('#br-reference').value.trim(), text: $('#br-answer').value.trim() } : null,
    resolutions: Object.fromEntries(Object.entries(resolutionInputs).map(([k, r]) => [k, { status: r.state.value, reason: r.reason.value.trim(), evidence_ids: r.evidence.filter(el => el.checked).map(el => el.value) }])),
    delivery: { kind, start: kind === 'window' ? $('#br-start').value : null, end: kind === 'window' ? $('#br-end').value : null } };
}

function render(data) {
  current = data;
  const { output, execution } = data;
  $('#ex-output').hidden = false;
  $('#ex-run').textContent = `状態: ${output.status} / 案件ID: ${output.request_id} / 監査ID: ${output.audit_log_id || '保存失敗'} / 外部送信試行: ${execution.external_attempts}回 / ${execution.prompt_version} / ${execution.rule_version}`;
  const methodLabels = { local_labelled_fallback: 'AIの範囲判定が不明のため、原文のローカル抽出下書き', gemini_fields: 'Gemini候補を原文検査', local_baseline: 'ローカル簡易抽出', not_extracted: '全体保留・未抽出' };
  if (execution.extraction_method) $('#ex-run').textContent += ` / 抽出方法: ${methodLabels[execution.extraction_method] || execution.extraction_method}`;
  list('#ex-warnings', output.warnings_and_holds.map(w => `[${w.code}] ${w.message} 対処: ${w.required_action}`));
  list('#ex-missing', output.missing_fields.length ? output.missing_fields.map(f => {
    const r = data.business_review?.resolutions[f.field_name];
    if (f.field_name === 'requested_delivery_date' && data.business_review?.delivery.kind === 'window') return `希望納期：期間 ${data.business_review.delivery.start} 〜 ${data.business_review.delivery.end} を記録。単一日は未設定。確認状態は下の一覧を参照。`;
    if (r?.status === 'not_required') return `${config.field_labels[f.field_name]}：今回不要として理由・根拠を記録済み（正式承認ではありません）。`;
    return `${config.field_labels[f.field_name]}：${f.reason}`;
  }) : [blocked() ? '依頼全体が保留・対象外・エラーのため、不足チェックは未完了です。' : '抽出項目に空欄はありません。原文との一致は人間が確認してください。']);
  const table = $('#ex-fields'); table.replaceChildren();
  for (const [key, field] of Object.entries(output.extracted_fields)) {
    const row = document.createElement('tr');
    const label = document.createElement('th'); label.scope = 'row'; label.textContent = config.field_labels[key];
    const value = document.createElement('td'); const input = document.createElement('input');
    input.type = key === 'quantity' ? 'number' : key === 'requested_delivery_date' ? 'date' : 'text';
    if (key === 'quantity') { input.min = '0'; input.step = 'any'; }
    input.setAttribute('aria-label', `${config.field_labels[key]}の修正下書き`);
    input.value = field.value ?? ''; input.maxLength = 1000;
    input.addEventListener('input', () => { $('#ex-reviewed').checked = false; });
    editable[key] = input; value.append(input);
    const quote = document.createElement('td'); quote.textContent = field.source_quote ?? '原文根拠なし';
    if (field.source_location) quote.textContent += `\n${field.source_location.source_id} [${field.source_location.start}, ${field.source_location.end})`;
    const confidence = document.createElement('td'); confidence.textContent = field.confidence === null ? '未評価' : String(field.confidence);
    row.append(label, value, quote, confidence); table.append(row);
  }
  $('#ex-reviewed').checked = false;
  $('#ex-json').textContent = JSON.stringify(data, null, 2);
  renderBusiness(data);
  resetSearch(true);
  document.dispatchEvent(new CustomEvent('extraction:rendered', { detail: data }));
  message(data.message || (output.status === 'error' ? '処理を停止しました。警告の内容を確認してください。'
    : blocked() ? '依頼全体を保留しました。抽出値は採用せず、確認操作による解除もできません。'
    : execution.extraction_method === 'local_labelled_fallback' ? 'AIは範囲を判別できませんでした。原文書式を検査してローカル抽出した下書きです。AI抽出成功ではありません。'
    : execution.mode === 'local' ? 'ローカル処理が終了しました。AI・外部送信は使用していません。'
      : execution.external_attempts ? 'Geminiの応答処理が終了しました。精度の合格ではありません。原文を照合してください。' : '依頼を保留しました。外部送信はしていません。'));
}

const searchInputs = {
  customer_name: '#ss-customer', product_code: '#ss-product-code', product_name: '#ss-product-name', material: '#ss-material',
  process_type: '#ss-process-type', quantity: '#ss-quantity', quantity_unit: '#ss-unit', dimensions: '#ss-dimensions', tolerance: '#ss-tolerance'
};
function currentSearchValues() {
  return { ...Object.fromEntries(Object.entries(searchInputs).map(([key, selector]) => [key, $(selector).value.trim() === '' ? null : key === 'quantity' ? Number($(selector).value) : $(selector).value.trim()])),
    requested_delivery_date: editable.requested_delivery_date?.value.trim() || null };
}
function copyCurrentToSearch() {
  for (const [key, selector] of Object.entries(searchInputs)) $(selector).value = editable[key]?.value ?? '';
  $('#ss-sample').value = '';
  $('#ss-ack').checked = false;
  resetProcessDecision();
}
function resetProcessDecision() {
  currentProcessSuggestion = null;
  $('#ss-process-message').textContent = '候補未確認';
  $('#ss-process-source').value = 'past_history';
  $('#ss-process-confirmed-by').value = '';
  $('#ss-process-basis').value = '';
  $('#ss-process-confirmed').checked = false;
}
function processDecisionReady() {
  const source = $('#ss-process-source').value;
  const value = $('#ss-process-type').value.trim();
  return $('#ss-process-confirmed').checked && $('#ss-process-confirmed-by').value.trim()
    && $('#ss-process-basis').value.trim() && (source === 'technical_required' ? !value : Boolean(value));
}
function readProcessDecision() {
  const source = $('#ss-process-source').value;
  return { source, value: source === 'technical_required' ? null : $('#ss-process-type').value.trim() || null,
    confirmed: source !== 'technical_required', confirmed_by: $('#ss-process-confirmed-by').value.trim(),
    basis: $('#ss-process-basis').value.trim() };
}
function renderProcessSuggestion(data) {
  currentProcessSuggestion = data.suggestion;
  const suggestion = data.suggestion;
  const candidates = suggestion.candidates.map(item => `${item.process_type}：${item.count}件（${item.share_percent}%）／${item.quote_ids.join('、') || '商品マスタ'}`);
  $('#ss-process-message').textContent = `${suggestion.master.note}\n${suggestion.next_action}${candidates.length ? `\n候補：${candidates.join(' / ')}` : ''}`;
  $('#ss-process-confirmed').checked = false;
  if (suggestion.status === 'master_confirmed') {
    if (!$('#ss-process-source').querySelector('option[value="product_master"]')) {
      const option = document.createElement('option'); option.value = 'product_master'; option.textContent = '商品マスタの確定済み値';
      $('#ss-process-source').prepend(option);
    }
    $('#ss-process-source').value = 'product_master';
    $('#ss-process-type').value = suggestion.master.value;
    $('#ss-process-basis').value = suggestion.master.note;
  } else if (suggestion.status === 'single_candidate') {
    const candidate = suggestion.candidates[0];
    $('#ss-process-source').value = 'past_history';
    $('#ss-process-type').value = candidate.process_type;
    $('#ss-process-basis').value = `同一顧客・品番・材質・数量の過去実績${candidate.count}件がすべて「${candidate.process_type}」。参照：${candidate.quote_ids.join('、')}`;
  } else {
    $('#ss-process-source').value = 'technical_required';
    $('#ss-process-type').value = '';
    $('#ss-process-basis').value = suggestion.next_action;
  }
  setBusy(false);
}
function resetSearch(copy = true) {
  currentSearch = null;
  $('#ss-entities').hidden = true;
  $('#ss-quotes-panel').hidden = true;
  $('#ss-customers').replaceChildren(); $('#ss-products').replaceChildren(); $('#ss-quote-results').replaceChildren();
  $('#ss-price-definition').textContent = ''; $('#ss-price-warning').textContent = ''; $('#ss-price-warning').className = 'price-analysis';
  $('#ss-json').textContent = '未実行'; $('#ss-message').textContent = '未実行'; $('#ss-ack').checked = false;
  resetProcessDecision();
  if (copy) copyCurrentToSearch();
}
function candidateCard(candidate, name, checked = false) {
  const card = document.createElement('div'); card.className = `candidate-card ${candidate.similarity_score >= 80 ? 'match-good' : 'match-warn'}`;
  const label = document.createElement('label'); const radio = document.createElement('input'); radio.type = 'radio'; radio.name = name; radio.value = candidate.candidate_id; radio.checked = checked;
  const title = document.createElement('strong'); title.textContent = `${candidate.candidate_id} / 得点 ${candidate.similarity_score} / マスタ${candidate.member_count}行`;
  label.append(radio, title); card.append(label);
  const representative = candidate.members[0] || {};
  const summary = document.createElement('div'); summary.className = 'candidate-summary';
  const representativeText = candidate.entity_type === 'customer'
    ? `代表: ${representative.customer_name || '不明'} / 拠点 ${representative.delivery_site || '不明'} / 担当 ${representative.sales_rep || '不明'}`
    : `代表: ${representative.product_code || '不明'} / ${representative.product_name || '不明'} / 材質 ${representative.material || '不明'} / ${representative.discontinued_flag || '状態不明'}`;
  summary.textContent = `${candidate.match_basis.map(b => b.reason).join(' / ')}\n${representativeText}${candidate.warnings.length ? `\n要確認: ${candidate.warnings.join(' / ')}` : ''}`;
  card.append(summary);
  const members = candidate.entity_type === 'customer'
    ? candidate.members.map(m => `${m.customer_id}: ${m.customer_name} / 請求名 ${m.billing_name || '不明'} / 拠点 ${m.delivery_site || '不明'}`).join('\n')
    : candidate.members.map(m => `${m.product_id}: ${m.product_code} / ${m.product_name} / 材質 ${m.material || '不明'} / ${m.discontinued_flag || '状態不明'}`).join('\n');
  const details = document.createElement('details');
  const detailsTitle = document.createElement('summary'); detailsTitle.textContent = `マスタ${candidate.member_count}行の詳細を表示`;
  const detail = document.createElement('div'); detail.className = 'candidate-members'; detail.textContent = members;
  details.append(detailsTitle, detail); card.append(details); return card;
}
function renderEntities(search) {
  const customers = $('#ss-customers'); customers.replaceChildren();
  const noCustomer = document.createElement('div'); noCustomer.className = 'candidate-card match-warn';
  const noCustomerLabel = document.createElement('label'); const noCustomerRadio = document.createElement('input'); noCustomerRadio.type = 'radio'; noCustomerRadio.name = 'ss-customer-candidate'; noCustomerRadio.value = '__none__';
  noCustomerLabel.append(noCustomerRadio, document.createTextNode('該当顧客なしとして商品だけで検索（顧客別条件は転用不可）')); noCustomer.append(noCustomerLabel);
  customers.append(noCustomer);
  search.entity_candidates.customers.forEach((c, i) => customers.append(candidateCard(c, 'ss-customer-candidate', i === 0 && c.similarity_score >= 80)));
  const products = $('#ss-products'); products.replaceChildren();
  if (!search.entity_candidates.products.length) products.textContent = '商品候補がありません。品番・品名を確認し、手動検索へ切り替えてください。';
  search.entity_candidates.products.forEach((c, i) => products.append(candidateCard(c, 'ss-product-candidate', i === 0 && c.similarity_score >= 80)));
  for (const radio of $('#ss-entities').querySelectorAll('input[name="ss-customer-candidate"],input[name="ss-product-candidate"]'))
    radio.addEventListener('change', () => { resetProcessDecision(); setBusy(false); });
  $('#ss-entities').hidden = false;
}
function quoteCard(quote, index) {
  const card = document.createElement('div'); card.className = `quote-card ${quote.similarity_score >= 75 ? 'match-good' : 'match-warn'}`;
  const label = document.createElement('label'); const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'ss-quote'; radio.value = quote.quote_id; radio.checked = index === 0;
  const title = document.createElement('strong'); title.textContent = `${quote.quote_id} / 得点 ${quote.similarity_score}`; label.append(radio, title); card.append(label);
  const basis = quote.match_basis.map(b => `${b.field}: ${b.reason}（${b.points}点、今回 ${b.current_value ?? '不明'} / 過去 ${b.past_value ?? '不明'}）`).join('\n');
  const diffs = quote.differences.filter(d => d.status !== 'same').map(d => `${d.field}: ${d.status} / ${d.attention}（過去 ${d.past_value ?? '不明'}）`).join('\n');
  const price = quote.differences.find(d => d.field === 'quote_price')?.past_value;
  const priceText = Number.isFinite(Number(price)) ? Number(price).toLocaleString('ja-JP') : '不明';
  const pastValue = (field) => quote.match_basis.find(item => item.field === field)?.past_value ?? '不明';
  const compact = document.createElement('div'); compact.className = 'candidate-summary';
  compact.textContent = `過去見積金額（原値）: ${priceText} / 見積日: ${pastValue('quote_date')} / 数量: ${pastValue('quantity')} / 材質: ${pastValue('material')} / 加工種別: ${pastValue('process_type')}`;
  card.append(compact);
  const details = document.createElement('details');
  const detailsTitle = document.createElement('summary'); detailsTitle.textContent = '一致根拠・差異・注意事項・参照情報を表示';
  const detail = document.createElement('div'); detail.className = 'candidate-detail';
  detail.textContent = `過去見積金額（quote_price原値）: ${priceText} / 金額種別・通貨・税区分: 原本で未定義\n【一致根拠】\n${basis}\n【差異・注意事項】\n${diffs}\n参照: ${quote.source_link || 'なし'} / データ基準: ${dateTimeText(quote.data_as_of)}`;
  details.append(detailsTitle, detail); card.append(details); return card;
}
function renderSearch(search) {
  currentSearch = search; $('#ss-json').textContent = JSON.stringify(search, null, 2);
  renderEntities(search);
  if (search.process_type_decision) {
    const decision = search.process_type_decision;
    $('#ss-process-source').value = decision.source;
    $('#ss-process-type').value = decision.value || '';
    $('#ss-process-confirmed-by').value = decision.confirmed_by || '';
    $('#ss-process-basis').value = decision.basis || '';
    $('#ss-process-confirmed').checked = true;
    $('#ss-process-message').textContent = decision.source === 'technical_required'
      ? '加工種別は未確定です。価格比較を実行せず、技術担当へ回す記録を保存しました。'
      : `加工種別「${decision.value}」を${decision.source === 'past_history' ? '過去実績候補の人間確認' : decision.source === 'technical_confirmed' ? '技術担当の確認' : '商品マスタ'}により記録しました。`;
  }
  if (search.status === 'entity_review') $('#ss-quotes-panel').hidden = true;
  if (search.status === 'quote_review' || search.status === 'reviewed') {
    const price = search.price_analysis;
    $('#ss-price-definition').textContent = price?.definition?.note || '過去見積金額の定義を確認できません。';
    $('#ss-price-warning').textContent = price?.message || '価格ばらつきを判定できません。';
    $('#ss-price-warning').className = `price-analysis ${price?.status === 'comparison_unavailable' ? 'stop' : price?.severity || 'none'}`;
    const node = $('#ss-quote-results'); node.replaceChildren();
    if (!search.similar_quotes.length) node.textContent = '該当する過去見積候補はありません。条件を勝手に緩めず、手動検索へ切り替えてください。';
    search.similar_quotes.forEach((quote, index) => node.append(quoteCard(quote, index)));
    const none = document.createElement('div'); none.className = 'quote-card match-warn'; const label = document.createElement('label'); const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'ss-quote'; radio.value = '__none__';
    label.append(radio, document.createTextNode('候補を採用せず、手動検索へ切り替える')); none.append(label); node.append(none);
    $('#ss-quotes-panel').hidden = false;
  }
  if (search.decision) { $('#ss-decision').value = search.decision.decision; $('#ss-reason').value = search.decision.reason; }
  $('#ss-message').textContent = `検索ID ${search.run_id} / 状態 ${search.status} / ルール ${search.rule_version} / 外部AI送信 ${search.security.external_ai_calls}回`;
  document.dispatchEvent(new CustomEvent('similar-search:rendered', { detail: search }));
  setBusy(false);
}

$('#extraction-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!config || working) return;
  const input = readInput();
  if (input.mode === 'gemini' && !input.consent) { message('送信先と匿名化本文を確認して、今回の送信に同意してください。'); return; }
  current = null; $('#ex-output').hidden = true;
  setBusy(true); message(input.mode === 'gemini' ? 'Geminiへ最大1回送信します。自動再試行はしません。' : '外部送信なしで処理しています。');
  try { render(await api('/api/extraction', input)); }
  catch (error) { message(error.message); }
  finally { setBusy(false); }
});

$('#extraction-sample').addEventListener('change', () => {
  const sample = config?.samples.find(s => s.id === $('#extraction-sample').value);
  if (!sample) return;
  for (const [key, selector] of Object.entries(fieldInputs)) $(selector).value = sample[key];
  $('#sample-source').textContent = sample.source;
  invalidateResult(); message('例文を読み込みました。まだ処理・外部送信はしていません。');
});
for (const selector of Object.values(fieldInputs)) $(selector).addEventListener('input', invalidateResult);
$('#ex-mode').addEventListener('change', invalidateResult);
for (const el of $('#business-editor').querySelectorAll('input,select,textarea')) el.addEventListener('input', dirty);
$('#br-delivery-kind').addEventListener('change', () => {
  if ($('#br-delivery-kind').value !== 'date' && editable.requested_delivery_date) editable.requested_delivery_date.value = '';
  setDeliveryInputs(); dirty();
});

$('#ex-save').addEventListener('click', async () => {
  if (!current || working) return;
  if (!$('#ex-reviewed').checked) { message('原文照合のチェックを入れてください。'); return; }
  const values = Object.fromEntries(Object.entries(editable).map(([k, input]) => [k, input.value.trim() === '' ? null : k === 'quantity' ? Number(input.value) : input.value.trim()]));
  const id = current.output.audit_log_id; const revision = current.revision;
  setBusy(true);
  try { render(await api(`/api/extraction/${id}/review`, { revision, values, acknowledged: true, ...(current.business_review && config.business_version ? { business_review: readBusiness() } : {}) })); }
  catch (error) { message(error.message); }
  finally { setBusy(false); }
});
$('#ex-reload').addEventListener('click', async () => {
  if (!current?.output.audit_log_id || working) return;
  const id = current.output.audit_log_id; setBusy(true);
  try { render(await api(`/api/extraction/${id}`)); }
  catch (error) { message(error.message); }
  finally { setBusy(false); }
});

$('#ss-current').addEventListener('click', () => { copyCurrentToSearch(); $('#ss-message').textContent = '現在の抽出候補を検索条件へコピーしました。まだ検索していません。'; });
$('#ss-sample').addEventListener('change', () => {
  const sample = searchConfig?.test_queries?.find(item => item.id === $('#ss-sample').value);
  if (!sample) { copyCurrentToSearch(); return; }
  for (const [key, selector] of Object.entries(searchInputs)) $(selector).value = sample[key] ?? '';
  $('#ss-ack').checked = false;
  $('#ss-message').textContent = '配布CSVに基づく検索テスト条件を読み込みました。抽出結果は変更していません。まだ検索していません。';
});
$('#ss-start').addEventListener('click', async () => {
  if (!current?.output.audit_log_id || working) return;
  if (!$('#ss-ack').checked) { $('#ss-message').textContent = '検索条件と候補提示の責任境界を確認し、チェックを入れてください。'; return; }
  setBusy(true); $('#ss-message').textContent = 'ローカルDBで名寄せ候補を検索しています。外部AIへは送信しません。';
  try { renderSearch(await api(`/api/extraction/${current.output.audit_log_id}/similar-search`, { revision: current.revision, values: currentSearchValues(), acknowledged: true })); }
  catch (error) { $('#ss-message').textContent = `エラー: ${error.message}`; }
  finally { setBusy(false); }
});
$('#ss-process-suggest').addEventListener('click', async () => {
  if (!currentSearch || working) return;
  const customer = document.querySelector('input[name="ss-customer-candidate"]:checked');
  const product = document.querySelector('input[name="ss-product-candidate"]:checked');
  if (!customer || !product) { $('#ss-process-message').textContent = '顧客候補（該当なしを含む）と商品候補を選択してください。'; return; }
  setBusy(true); $('#ss-process-message').textContent = 'ローカルDBの過去実績から加工種別候補を確認しています。外部AIは使用しません。';
  try { renderProcessSuggestion(await api(`/api/similar-search/${currentSearch.run_id}/process-types`, {
    revision: currentSearch.revision, customer_candidate_id: customer.value === '__none__' ? null : customer.value,
    product_candidate_id: product.value })); }
  catch (error) { $('#ss-process-message').textContent = `エラー: ${error.message}`; }
  finally { setBusy(false); }
});
for (const id of ['ss-process-type','ss-process-source','ss-process-confirmed-by','ss-process-basis','ss-process-confirmed']) {
  $('#' + id).addEventListener('input', () => {
    if (id === 'ss-process-source' && $('#ss-process-source').value === 'technical_required') $('#ss-process-type').value = '';
    if (id !== 'ss-process-confirmed') $('#ss-process-confirmed').checked = false;
    setBusy(false);
  });
}
$('#ss-quotes').addEventListener('click', async () => {
  if (!currentSearch || working) return;
  const customer = document.querySelector('input[name="ss-customer-candidate"]:checked');
  const product = document.querySelector('input[name="ss-product-candidate"]:checked');
  if (!customer || !product) { $('#ss-message').textContent = '顧客候補（該当なしを含む）と商品候補を選択してください。'; return; }
  if (!processDecisionReady()) { $('#ss-process-message').textContent = '加工種別の確定経路、確認者、根拠を入力し、確認チェックを入れてください。未確定なら「技術確認へ回す」を選びます。'; return; }
  setBusy(true); $('#ss-message').textContent = '選択条件で過去見積を検索しています。価格はローカルDB内だけで扱います。';
  try { renderSearch(await api(`/api/similar-search/${currentSearch.run_id}/quotes`, { revision: currentSearch.revision,
    customer_candidate_id: customer.value === '__none__' ? null : customer.value, product_candidate_id: product.value,
    process_type_decision: readProcessDecision() })); }
  catch (error) { $('#ss-message').textContent = `エラー: ${error.message}`; }
  finally { setBusy(false); }
});
$('#ss-save-decision').addEventListener('click', async () => {
  if (!currentSearch || working) return;
  const selected = document.querySelector('input[name="ss-quote"]:checked');
  const reason = $('#ss-reason').value.trim();
  if (!selected || !reason) { $('#ss-message').textContent = '候補または手動検索を選び、採用・却下理由を入力してください。'; return; }
  const quoteId = selected.value === '__none__' ? null : selected.value;
  let decision = $('#ss-decision').value;
  if (quoteId === null) decision = 'rejected';
  setBusy(true);
  try { renderSearch(await api(`/api/similar-search/${currentSearch.run_id}/decision`, { revision: currentSearch.revision, quote_id: quoteId, decision, reason })); }
  catch (error) { $('#ss-message').textContent = `エラー: ${error.message}`; }
  finally { setBusy(false); }
});

try {
  config = await api('/api/extraction/config');
  for (const sample of config.samples) { const option = document.createElement('option'); option.value = sample.id; option.textContent = sample.label; $('#extraction-sample').append(option); }
  $('#ex-mode option[value="gemini"]').disabled = !config.gemini_configured;
  $('#ex-destination').textContent = `送信先：Google Gemini API（generativelanguage.googleapis.com） / 設定モデル：${config.model}`;
  $('#ex-text').maxLength = config.max_text_length;
  searchConfig = await api('/api/similar-search/config');
  for (const sample of searchConfig.test_queries) { const option = document.createElement('option'); option.value = sample.id; option.textContent = sample.label; $('#ss-sample').append(option); }
} catch { message('抽出機能を読み込めません。サーバーを再起動し、抽出用テーブルを準備してください。'); $('#ex-submit').disabled = true; }
