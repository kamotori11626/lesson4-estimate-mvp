import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('類似見積は要約を常時表示し、詳細情報は折りたたむ', async () => {
  const source = await readFile(new URL('../public/extraction.js', import.meta.url), 'utf8');

  assert.match(source, /過去見積金額（原値）/u);
  assert.match(source, /見積日:/u);
  assert.match(source, /数量:/u);
  assert.match(source, /材質:/u);
  assert.match(source, /加工種別:/u);
  assert.match(source, /document\.createElement\('details'\)/u);
  assert.match(source, /一致根拠・差異・注意事項・参照情報を表示/u);
  assert.match(source, /details\.append\(detailsTitle, detail\)/u);
});
