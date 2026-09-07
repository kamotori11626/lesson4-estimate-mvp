import { approverText } from './approval-view.js';

const $ = selector => document.querySelector(selector);
let extraction = null;
let config = null;
let approval = null;
let draft = null;
let previewSequence = 0;
const fieldLabels = { customer_name: '顧客名', product_name: '品名', product_code: '品番', material: '材質',
  quantity: '数量', quantity_unit: '数量単位', dimensions: '寸法', tolerance: '公差', requested_delivery_date: '希望納期' };

async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '処理に失敗しました。');
  return data;
}
function numberOrNull(id) { const value = $(id).value.trim(); return value === '' ? null : Number(value); }
function labelForField(name) { return fieldLabels[name] || name; }
function currentValue(name) { return extraction?.output?.extracted_fields?.[name]?.value ?? null; }
function reset() {
  approval = null; draft = null; $('#ae-result').hidden = true; $('#ae-draft').hidden = true;
  $('#ae-approvers').hidden = true; $('#ae-approvers').textContent = '';
  $('#ae-message').textContent = '未実行'; $('#ae-draft-message').textContent = '未作成';
  $('#ae-review-message').textContent = '未記録'; $('#ae-ack').checked = false;
  for (const id of ['#ae-price','#ae-cost','#ae-list-price','#ae-route-basis','#ae-sender','#ae-customer-reference','#ae-questions',
    '#ae-subject','#ae-body','#ae-review-reason']) $(id).value = '';
  $('#ae-tech').checked = false; $('#ae-supplier').checked = false; $('#ae-consent').checked = false;
  $('#ae-draft-type').value = 'customer_inquiry'; $('#ae-recipient').value = '顧客担当者';
  $('#ae-draft-mode').value = 'local'; $('#ae-decision').value = 'adopted';
  preview();
}
function invalidateApproval() {
  if (!approval) { $('#ae-ack').checked = false; return; }
  approval = null; draft = null;
  $('#ae-result').hidden = true; $('#ae-draft').hidden = true;
  $('#ae-approvers').hidden = true; $('#ae-approvers').textContent = '';
  $('#ae-ack').checked = false;
  $('#ae-message').textContent = '判定条件が変更されました。もう一度「承認要否を判定・記録」を実行してください。';
  $('#ae-draft-message').textContent = '承認要否の再判定後に作成できます。';
  $('#ae-review-message').textContent = '未記録';
}
function invalidateDraft() {
  if (!draft) { preview(); return; }
  draft = null;
  $('#ae-draft').hidden = true;
  $('#ae-draft-message').textContent = '文面条件が変更されました。下書きを作り直してください。';
  $('#ae-review-message').textContent = '未記録';
  preview();
}
function syncGenerateButton() {
  const external = $('#ae-draft-mode').value === 'gemini';
  $('#ae-generate').disabled = external && ($('#ae-consent').disabled || !$('#ae-consent').checked);
}
function preview() {
  const sequence = ++previewSequence;
  const external = $('#ae-draft-mode').value === 'gemini';
  $('#ae-external').hidden = !external; $('#ae-consent').checked = false;
  $('#ae-consent').disabled = true;
  syncGenerateButton();
  if (!external) { $('#ae-preview').textContent = ''; return; }
  if (!approval) { $('#ae-preview').textContent = '承認要否を判定した後に、サーバーが実送信JSONを作成します。'; return; }
  $('#ae-preview').textContent = 'サーバーで実送信JSONを作成しています。外部送信はしていません。';
  api(`/api/approval-email/${approval.run_id}/draft-preview`, draftInput()).then(data => {
    if (sequence !== previewSequence) return;
    $('#ae-preview').textContent = JSON.stringify(data.preview, null, 2);
    $('#ae-consent').disabled = !config?.gemini_configured;
    syncGenerateButton();
  }).catch(error => {
    if (sequence !== previewSequence) return;
    $('#ae-preview').textContent = `プレビューを作成できません：${error.message}`;
  });
}
function renderApproval(data) {
  approval = data;
  const result = data.approval;
  const labels = { required: '承認・社内確認が必要', not_required: '現在の入力条件では承認トリガーなし', hold: '保留' };
  $('#ae-result').hidden = false;
  $('#ae-summary').className = `approval-result ${result.status}`;
  $('#ae-summary').textContent = `${labels[result.status]}\n再計算した粗利率：${result.calculated_values.gross_margin_rate ?? '計算不能'}% / 値引率：${result.calculated_values.discount_rate ?? '計算不能'}%${result.reason ? `\n理由：${result.reason}` : ''}\nルール版：${result.rule_version}`;
  const approvers = approverText(result.approver_roles);
  $('#ae-approvers').hidden = approvers === null;
  $('#ae-approvers').textContent = approvers || '';
  const list = $('#ae-rules'); list.replaceChildren();
  for (const rule of result.rule_results) { const item = document.createElement('li'); item.textContent = `${rule.rule_id}：${rule.outcome} — ${rule.reason}`; list.append(item); }
  $('#ae-json').textContent = JSON.stringify(data, null, 2);
  $('#ae-message').textContent = `判定ID ${data.run_id}を保存しました。これは正式承認ではありません。`;
  $('#ae-draft').hidden = true; draft = null; $('#ae-draft-message').textContent = '未作成';
  $('#ae-review-message').textContent = '未記録'; preview();
  document.dispatchEvent(new CustomEvent('approval:rendered', { detail: data }));
}
function draftInput() {
  const product = [currentValue('product_code'), currentValue('product_name')].filter(Boolean).join(' / ') || null;
  return { draft_type: $('#ae-draft-type').value, mode: $('#ae-draft-mode').value,
    recipient_role: $('#ae-recipient').value.trim(),
    missing_items: (extraction.output.missing_fields || []).map(item => ({ id: item.field_name, label: labelForField(item.field_name) })),
    questions: $('#ae-questions').value.split('\n').map(v => v.trim()).filter(Boolean),
    customer_name: currentValue('customer_name'), product_label: product,
    request_id: extraction.output.request_id, customer_reference: $('#ae-customer-reference').value.trim() || null,
    sender_name: $('#ae-sender').value.trim() || null,
    consent: $('#ae-consent').checked };
}
function renderDraft(data) {
  draft = data; $('#ae-draft').hidden = false;
  $('#ae-subject').value = data.draft.subject; $('#ae-body').value = data.draft.body;
  $('#ae-quality').className = `approval-result ${data.quality.passed ? '' : 'blocked'}`;
  $('#ae-quality').textContent = data.quality.passed ? '機械的な品質検査：合格。送信前の人間確認は別途必要です。'
    : `機械的な品質検査：不合格\n${data.quality.violations.map(v => `・${v.message}`).join('\n')}`;
  $('#ae-draft-message').textContent = data.generation_method === 'local_template'
    ? 'ローカル定型文で下書きを作成しました。外部送信は行っていません。'
    : 'Geminiへ匿名・最小化情報を1回送信し、下書きを作成しました。顧客へのメール送信は行っていません。';
  $('#ae-review-message').textContent = '下書きの判断は未記録です。内容を確認し、採用または却下を記録してください。';
  document.dispatchEvent(new CustomEvent('draft:rendered', { detail: data }));
}
function markDraftEdited() {
  if (!draft) return;
  $('#ae-quality').className = 'approval-result hold';
  $('#ae-quality').textContent = '編集後の内容は未検査です。「下書きの判断を記録」時に禁止表現・不足項目・入力との対応を再検査します。';
  $('#ae-review-message').textContent = '編集後の下書きについて、採用・却下の判断は未記録です。';
}

document.addEventListener('extraction:rendered', event => { extraction = event.detail; reset(); });
for (const id of ['#ae-price','#ae-cost','#ae-list-price','#ae-tech','#ae-supplier','#ae-route-basis']) $(id).addEventListener('input', invalidateApproval);
for (const id of ['#ae-draft-type','#ae-recipient','#ae-questions','#ae-draft-mode','#ae-sender','#ae-customer-reference']) $(id).addEventListener('input', invalidateDraft);
$('#ae-consent').addEventListener('change', syncGenerateButton);
$('#ae-draft-type').addEventListener('change', () => {
  const customer = ['customer_inquiry','quote_notice'].includes($('#ae-draft-type').value);
  $('#ae-recipient').value = customer ? '顧客担当者' : '技術担当者'; preview();
});
$('#ae-evaluate').addEventListener('click', async () => {
  if (!extraction?.output?.audit_log_id) return;
  if (!$('#ae-ack').checked) { $('#ae-message').textContent = '入力値と責任境界を確認し、チェックを入れてください。'; return; }
  $('#ae-evaluate').disabled = true; $('#ae-message').textContent = 'ローカルルールで判定し、根拠を保存しています。';
  try { renderApproval(await api(`/api/extraction/${extraction.output.audit_log_id}/approval-email`, {
    planned_price: numberOrNull('#ae-price'), cost: numberOrNull('#ae-cost'), list_price: numberOrNull('#ae-list-price'),
    required_tech_review: $('#ae-tech').checked, required_supplier_quote: $('#ae-supplier').checked,
    route_basis: $('#ae-route-basis').value.trim(), acknowledged: true })); }
  catch (error) { $('#ae-message').textContent = `エラー：${error.message}`; }
  finally { $('#ae-evaluate').disabled = false; }
});
$('#ae-generate').addEventListener('click', async () => {
  if (!approval) return;
  if ($('#ae-draft-mode').value === 'gemini' && !$('#ae-consent').checked) { $('#ae-draft-message').textContent = '匿名・最小化情報を確認し、今回の送信に同意してください。'; return; }
  $('#ae-generate').disabled = true; $('#ae-draft-message').textContent = $('#ae-draft-mode').value === 'gemini' ? 'Geminiへ1回送信しています。自動再試行しません。' : '外部送信なしで定型文を作成しています。';
  try { renderDraft(await api(`/api/approval-email/${approval.run_id}/drafts`, draftInput())); }
  catch (error) { $('#ae-draft-message').textContent = `エラー：${error.message}`; }
  finally { syncGenerateButton(); }
});
$('#ae-save-review').addEventListener('click', async () => {
  if (!approval || !draft) return;
  $('#ae-save-review').disabled = true;
  try {
    draft = await api(`/api/approval-email/${approval.run_id}/drafts/${draft.draft_id}/review`, {
      subject: $('#ae-subject').value, body: $('#ae-body').value, decision: $('#ae-decision').value,
      reason: $('#ae-review-reason').value.trim(), reviewer: $('#ae-reviewer').value.trim() });
    $('#ae-review-message').textContent = `下書きの${draft.status === 'adopted' ? '採用' : '却下'}記録を保存しました。メール送信は行っていません。`;
    document.dispatchEvent(new CustomEvent('draft:rendered', { detail: draft }));
  } catch (error) { $('#ae-review-message').textContent = `エラー：${error.message}`; }
  finally { $('#ae-save-review').disabled = false; }
});
$('#ae-subject').addEventListener('input', markDraftEdited);
$('#ae-body').addEventListener('input', markDraftEdited);

try {
  config = await api('/api/approval-email/config');
  $('#ae-draft-mode option[value="gemini"]').disabled = !config.gemini_configured;
  preview();
} catch { $('#ae-evaluate').disabled = true; $('#ae-message').textContent = 'サーバー再起動と承認判定用テーブルの準備が必要です。'; }
