import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForSearch } from '../src/db.mjs';

test('顧客名の表記揺れを検索用に正規化する', () => {
  assert.equal(normalizeForSearch('旧：ミナト医療機器株式会社'), 'ミナト医療機器');
  assert.equal(normalizeForSearch('北斗包装機械 Co.,Ltd.'), '北斗包装機械');
});

test('品番のハイフンと全角を検索用に正規化する', () => {
  assert.equal(normalizeForSearch('ＡＬ－ＢＫＴ－２２－Ａ'), 'albkt22a');
});
