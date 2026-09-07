import { ExtractionError } from './extraction.mjs';

const STATE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function validateRequestBoundary(request, settings) {
  const expectedHost = settings.appOrigin?.host;
  if (!expectedHost || request.headers.host !== expectedHost)
    throw new ExtractionError('HOST_NOT_ALLOWED', '許可されたURLからアクセスしてください。', 403);
  const origin = request.headers.origin;
  if (origin && origin !== settings.appOrigin.origin)
    throw new ExtractionError('ORIGIN_NOT_ALLOWED', '許可された画面から操作してください。', 403);
  if (request.headers['sec-fetch-site'] === 'cross-site')
    throw new ExtractionError('CROSS_SITE_REJECTED', '別サイトからの操作は受け付けません。', 403);
  if (STATE_METHODS.has(request.method)) {
    if (origin !== settings.appOrigin.origin)
      throw new ExtractionError('ORIGIN_REQUIRED', '同じ画面から操作してください。', 403);
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
      throw new ExtractionError('JSON_REQUIRED', 'JSON形式で送信してください。', 415);
  }
}

export function safeRoute(pathname) {
  return pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id');
}
