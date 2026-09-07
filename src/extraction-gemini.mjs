import { ExtractionError } from './extraction.mjs';
import { MODEL_SCHEMA } from './extraction-schema.mjs';
import { EXTRACTION_PROMPT } from './extraction-prompt.mjs';
import { matchingSample } from './extraction-samples.mjs';

export function prepareExternal(input) {
  if (!matchingSample(input)) throw new ExtractionError('EXTERNAL_DATA_NOT_APPROVED', '実業務文・変更した例文はまだ外部送信できません。今回は用意された匿名サンプルだけで実AIを試験できます。', 403);
  // An exact sample match is the security boundary, not a regex pretending to anonymize arbitrary business text.
  const text = input.request_text.split(input.customer_name).join('[CUSTOMER]');
  if (text.includes(input.customer_name) || /図面番号|見積金額|粗利率|単価|https?:|@|AIza/.test(text))
    throw new ExtractionError('MASKING_FAILED', '送信前検査に失敗しました。外部送信を停止しました。', 403);
  return text;
}

export async function extractWithGemini({ text, apiKey, model, fetchFn = fetch, timeoutMs = 30_000 }) {
  if (!apiKey) throw new ExtractionError('AI_KEY_MISSING', 'GeminiのAPIキーが未設定です。外部送信していません。', 503);
  let response;
  try {
    response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: MODEL_SCHEMA, maxOutputTokens: 4096 }
      })
    });
    if (!response.ok) throw new ExtractionError('AI_HTTP_ERROR', `GeminiからHTTP ${response.status}が返りました。再試行はしていません。`, 502);
    const data = await response.json();
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw new ExtractionError('AI_INCOMPLETE', 'AI応答が正常完了していません。途中の結果は採用しません。', 502);
    const raw = (candidate?.content?.parts || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_RESPONSE_ERROR',
      'AIとの通信またはJSONの読み取りに失敗しました。再試行せず停止しました。', 502);
  }
}
