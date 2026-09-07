import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('共有CSSは認証セッション判定より前に配信される', async () => {
  const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const publicAssetRoute = source.indexOf("publicFiles.has(url.pathname.slice(1))");
  const sessionLookup = source.indexOf('const user = await auth.getSession(request)');

  assert.ok(publicAssetRoute >= 0, '公開アセットの配信処理が必要です');
  assert.ok(sessionLookup >= 0, 'セッション判定処理が必要です');
  assert.ok(publicAssetRoute < sessionLookup, 'CSSはログイン済みでも404にならないよう、セッション判定より先に配信します');
});

test('メイン画面とログイン画面は同じ元UIのCSSを参照する', async () => {
  const [index, login, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/login.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/styles.css', import.meta.url), 'utf8')
  ]);

  assert.match(index, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(login, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(css, /:root\s*\{/);
  assert.match(css, /background:\s*linear-gradient\(135deg,\s*#153a62,\s*#157e7a\)/);
});
