import { navigateToWorkflowTarget } from './workflow-navigation.js';

const $ = selector => document.querySelector(selector);
let workflowId = null;
let refreshSequence = 0;

const statusLabels = { completed: '完了', current: '現在の作業', pending: '未着手', blocked: '保留' };
const statusSymbols = { completed: '✓', current: '→', pending: '・', blocked: '!' };

function formatTime(value) {
  return value ? new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST' : '時刻不明';
}

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '不明';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function renderSteps(steps) {
  const node = $('#workflow-steps');
  node.replaceChildren();
  for (const item of steps) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `workflow-step ${item.status}`;
    card.dataset.target = item.target_id;
    card.setAttribute('aria-label', `${item.label}：${statusLabels[item.status]}`);
    const symbol = document.createElement('span'); symbol.className = 'workflow-symbol'; symbol.textContent = statusSymbols[item.status];
    const body = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = item.label;
    const detail = document.createElement('small'); detail.textContent = `${statusLabels[item.status]}：${item.detail}`;
    body.append(title, detail); card.append(symbol, body); node.append(card);
  }
}

function handoffText(data) {
  const extraction = data.handoffs.extraction_to_search;
  const search = data.handoffs.search_to_approval;
  const draft = data.handoffs.approval_to_draft;
  const extractionValues = extraction.transferred_values || {};
  const transferred = ['customer_name','product_code','product_name','material','quantity','quantity_unit','process_type']
    .map(key => `${key}: ${displayValue(extractionValues[key])}`).join('\n');
  return [
    `抽出 → 類似検索：${extraction.status}\n${transferred || '未実行'}`,
    `類似検索 → 承認判定：${search.status}\n検索ID: ${search.source_similar_search_run_id || '未連携'}`,
    `承認判定 → 文面下書き：${draft.status}\n承認ID: ${draft.source_approval_run_id || '未連携'}`
  ];
}

function renderLogs(data) {
  const node = $('#workflow-log-list'); node.replaceChildren();
  if (!data.logs.length) { node.textContent = '保存された処理ログはありません。'; return; }
  for (const item of data.logs) {
    const row = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = `${formatTime(item.occurred_at)}｜${item.source}｜${item.event_type}`;
    const summary = document.createElement('pre'); summary.textContent = JSON.stringify(item.summary, null, 2);
    row.append(title, summary); node.append(row);
  }
}

function renderWorkflow(data) {
  $('#workflow-empty').hidden = true;
  $('#workflow-content').hidden = false;
  $('#workflow-id').textContent = `案件ID ${data.request_id}／ワークフローID ${data.workflow_id}／状態 ${data.status}`;
  renderSteps(data.steps);
  $('#workflow-next-action').textContent = data.next_action.label;
  $('#workflow-next').dataset.target = data.next_action.target_id;
  const handoffs = $('#workflow-handoffs'); handoffs.replaceChildren();
  for (const text of handoffText(data)) { const item = document.createElement('pre'); item.textContent = text; handoffs.append(item); }
  const summary = {
    input_summary: data.input_summary,
    extraction: data.results.extraction,
    top_similar_cases: data.results.similar_search?.top_similar_cases || [],
    approval: data.results.approval,
    draft: data.results.draft,
    security: data.security
  };
  $('#workflow-results').textContent = JSON.stringify(summary, null, 2);
  renderLogs(data);
}

async function refresh() {
  if (!workflowId) return;
  const sequence = ++refreshSequence;
  $('#workflow-refresh').disabled = true;
  try {
    const response = await fetch(`/api/workflow/${workflowId}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '統合状況を読み込めません。');
    if (sequence === refreshSequence) renderWorkflow(data);
  } catch (error) {
    $('#workflow-next-action').textContent = `統合状況を更新できません：${error.message}。サーバーとDB準備を確認してください。`;
  } finally {
    if (sequence === refreshSequence) $('#workflow-refresh').disabled = false;
  }
}

function goToTarget(target) {
  navigateToWorkflowTarget({ document, targetId: target });
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-target]');
  if (button?.dataset.target) goToTarget(button.dataset.target);
});
for (const eventName of ['similar-search:rendered','approval:rendered','draft:rendered'])
  document.addEventListener(eventName, () => { if (workflowId) refresh(); });
document.addEventListener('extraction:rendered', event => {
  workflowId = event.detail?.output?.audit_log_id || null;
  if (workflowId) refresh();
});
$('#workflow-refresh').addEventListener('click', refresh);
