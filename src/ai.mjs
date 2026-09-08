import { config } from './config.mjs';
import { diagnoseGemini } from './gemini-diagnostic.mjs';

let lastDiagnostic = null;
let pendingDiagnostic = null;

function recordDiagnosticStage(entry) {
  // The diagnostic emits stage/timing metadata only. Never add keys, prompts,
  // response bodies or exception text to this production log.
  console.info(JSON.stringify(entry));
}

export function aiStatus() {
  if (config.ai.provider === 'mock') {
    return { connected: false, mode: 'mock', detail: '外部送信なし。AI接続境界のみ検証可能です。' };
  }
  if (config.ai.provider !== 'gemini') {
    return { connected: false, mode: config.ai.provider, detail: '未対応のAI_PROVIDERです。' };
  }
  if (!config.ai.apiKey) {
    return { connected: false, mode: 'gemini', detail: 'GEMINI_API_KEYが未設定です。' };
  }
  return {
    connected: lastDiagnostic?.verified_external_connection === true,
    configured: true, mode: 'gemini',
    detail: lastDiagnostic?.verified_external_connection
      ? 'このサーバーで実応答を確認済みです。'
      : 'キー設定済み。実応答の成功は未確認です（固定文・送信1回の診断）。'
  };
}

export async function testAi() {
  if (config.ai.provider !== 'gemini') {
    return {
      mode: config.ai.provider, attempts: 0, verified_external_connection: false,
      error: 'Gemini診断はAI_PROVIDER=geminiのときのみ実行します。外部送信していません。'
    };
  }
  // Concurrent clicks share the same request instead of consuming extra quota.
  if (pendingDiagnostic) return pendingDiagnostic;
  pendingDiagnostic = diagnoseGemini({
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    onStage: recordDiagnosticStage
  });
  try {
    lastDiagnostic = await pendingDiagnostic;
    return lastDiagnostic;
  } finally {
    pendingDiagnostic = null;
  }
}
