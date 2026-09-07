import fs from 'node:fs/promises';
import { pool } from '../src/db.mjs';
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(await fs.readFile(new URL('../db/approval-email.sql', import.meta.url), 'utf8'));
  await client.query('COMMIT');
  console.log('承認判定・メール下書き用テーブルを追加しました。既存データの変更・再取込はしていません。');
} catch {
  if (client) await client.query('ROLLBACK');
  console.error('承認判定・メール下書き用テーブルの準備に失敗しました。DB起動状態・抽出用テーブルを確認してください。');
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
