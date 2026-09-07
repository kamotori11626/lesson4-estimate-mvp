const statusNode = document.querySelector('#status');
const countsNode = document.querySelector('#counts');
const originalFetch = window.fetch.bind(window);

function localDateTime(value) {
  if (!value) return 'まだありません';
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
}

async function refreshDemoInfo() {
  const response = await originalFetch('/api/demo/info');
  if (response.status === 401) { location.replace('/login'); return; }
  if (!response.ok) return;
  const info = await response.json();
  document.querySelector('#demo-user').textContent = info.user.displayName;
  document.querySelector('#demo-date').textContent = info.data_as_of;
  document.querySelector('#demo-last-operation').textContent = localDateTime(info.last_operation_at);
  document.querySelector('#br-recorder').value = info.user.displayName;
  document.querySelector('#ae-reviewer').value = info.user.displayName;
}

window.fetch = async (url, options = {}) => {
  const response = await originalFetch(url, options);
  if (response.status === 401) { location.replace('/login'); return response; }
  if (response.ok && String(options.method || 'GET').toUpperCase() === 'POST' && !String(url).includes('/api/demo/info')) {
    setTimeout(() => refreshDemoInfo().catch(() => {}), 0);
  }
  return response;
};

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.diagnostic = data;
    throw error;
  }
  return data;
}

function statusCard(label, ok, detail) {
  return `<article class="card ${ok ? 'ok' : 'warn'}"><strong>${label}</strong><span>${ok ? '確認済み' : '要対応'}</span><small>${detail || ''}</small></article>`;
}

async function load() {
  try {
    const health = await request('/api/health');
    statusNode.innerHTML = [statusCard('アプリ・DB', health.ok, health.ok ? '利用できます' : '利用できません')].join('');
    const { counts } = await request('/api/counts');
    countsNode.innerHTML = counts.map(row => `<tr><td>${row.label}</td><td>${row.count.toLocaleString()}件</td></tr>`).join('');
    await refreshDemoInfo();
  } catch (error) {
    statusNode.textContent = error.message;
  }
}

document.querySelector('#write-check').addEventListener('click', async () => {
  const node = document.querySelector('#write-result');
  try {
    const data = await request('/api/db/write-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    node.textContent = `確認済み: ID ${data.result.id} / ${data.result.checked_at}`;
  } catch (error) { node.textContent = `エラー: ${error.message}`; }
});

document.querySelector('#search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const node = document.querySelector('#search-result');
  try {
    const type = document.querySelector('#search-type').value;
    const q = document.querySelector('#search-query').value;
    const data = await request(`/api/search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`);
    node.textContent = JSON.stringify(data.results, null, 2);
  } catch (error) { node.textContent = `エラー: ${error.message}`; }
});

document.querySelector('#ai-form').addEventListener('submit', async event => {
  event.preventDefault();
  const node = document.querySelector('#ai-result');
  const button = event.currentTarget.querySelector('button');
  try {
    button.disabled = true;
    node.textContent = '固定文でGeminiへ1回だけ接続中です。自動再試行はしません（待機上限30秒）。';
    if (!document.querySelector('#ai-consent').checked) throw new Error('送信前プレビューを確認し、今回の送信に同意してください。');
    const data = await request('/api/ai/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true })
    });
    node.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    node.textContent = error.diagnostic
      ? JSON.stringify(error.diagnostic, null, 2)
      : `エラー: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#logout').addEventListener('click', async () => {
  await request('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  location.replace('/login');
});

document.querySelector('#demo-reset').addEventListener('click', async () => {
  const node = document.querySelector('#demo-reset-message');
  const confirmed = window.confirm('CSV由来データを再投入し、抽出・名寄せ・承認・下書き・DB書込確認の操作記録を初期化します。監査ログ・ログイン状態・CSV原本は保持します。実行しますか？');
  if (!confirmed) { node.textContent = 'キャンセルしました。'; return; }
  try {
    const result = await request('/api/demo/reset', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'RESET_DEMO_DATA' }) });
    node.textContent = `完了: ${result.scope}`;
    await load();
  } catch (error) { node.textContent = `エラー: ${error.message}`; }
});

load();
