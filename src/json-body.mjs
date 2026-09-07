import { ExtractionError } from './extraction.mjs';

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 120_000) throw new ExtractionError('BODY_TOO_LARGE', '送信内容が大きすぎます。', 413);
    chunks.push(bytes);
  }
  let body;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new ExtractionError('INVALID_UTF8', 'UTF-8の文字列を入力してください。'); }
  if (body.length > 30_000) throw new ExtractionError('BODY_TOO_LARGE', '送信内容が大きすぎます。', 413);
  try { return body ? JSON.parse(body) : {}; }
  catch { throw new ExtractionError('INVALID_JSON', 'JSON形式が不正です。', 400); }
}
