const form = document.querySelector('#login-form');
const message = document.querySelector('#login-message');

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  message.textContent = '確認中です…';
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'ログインできませんでした。');
    location.replace('/');
  } catch (error) {
    message.textContent = error.message;
    form.password.value = '';
  } finally { button.disabled = false; }
});
