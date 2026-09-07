export const diagnosticPrompt = '接続確認です。日本語でOKとだけ答えてください。';

// Return only explicitly selected fields, never raw responses, headers or credentials.
function safeText(value, apiKey) {
  let text = typeof value === 'string' ? value : '';
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return text
    .replace(/AIza[\w-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL omitted]')
    .replace(/(?:api[_ -]?key|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '[credential omitted]')
    .replace(/\s+/g, ' ').trim().slice(0, 800);
}

export async function diagnoseGemini({ apiKey, model, fetchFn = fetch, timeoutMs = 30_000 }) {
  const startedAt = Date.now();
  const base = {
    mode: 'gemini', model: safeText(model, apiKey), attempts: 0,
    verified_external_connection: false
  };
  const finish = fields => ({ ...base, elapsed_ms: Date.now() - startedAt, ...fields });
  if (!apiKey) return finish({ error: 'GEMINI_API_KEYが未設定です。' });

  let httpStatus = null;
  try {
    // Exactly one fetch call: no retries and no redirect forwarding of the API key.
    base.attempts = 1;
    const response = await fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: diagnosticPrompt }] }],
          generationConfig: { maxOutputTokens: 80 }
        })
      }
    );
    httpStatus = response.status;
    const data = await response.json();
    if (!response.ok) {
      const reasons = Array.isArray(data?.error?.details)
        ? data.error.details.map(item => safeText(item?.reason, apiKey)).filter(Boolean) : [];
      return finish({
        http_status: httpStatus,
        provider_status: safeText(data?.error?.status, apiKey),
        provider_message: safeText(data?.error?.message, apiKey),
        provider_reasons: reasons.slice(0, 5),
        error: `Gemini APIからHTTP ${httpStatus}が返りました（送信1回・再試行なし）。`
      });
    }
    const parts = data?.candidates?.[0]?.content?.parts;
    const output = Array.isArray(parts)
      ? parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('').trim()
      : '';
    if (!output) return finish({
      http_status: httpStatus,
      finish_reason: safeText(data?.candidates?.[0]?.finishReason, apiKey),
      error: 'HTTP応答は成功しましたが、回答テキストがありません。生成成功は未確認です。'
    });
    return finish({ http_status: httpStatus, verified_external_connection: true, response: safeText(output, apiKey) });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return finish({
      http_status: httpStatus,
      failure_kind: timeout ? 'timeout' : error?.name === 'SyntaxError' ? 'invalid_json' : 'transport',
      error: timeout
        ? `${timeoutMs / 1_000}秒で診断の待機を終了しました。Google側の処理停止は保証できません。再試行はしていません。`
        : '通信または応答の読み取りに失敗しました。秘密情報保護のため例外の原文は表示しません。'
    });
  }
}
