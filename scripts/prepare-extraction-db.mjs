import fs from 'node:fs/promises';
import { pool } from '../src/db.mjs';
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(await fs.readFile(new URL('../db/extraction.sql', import.meta.url), 'utf8'));
  await client.query('COMMIT');
  console.log('情報抽出用テーブルを準備しました。既存CSVテーブルの変更・再取込はしていません。');
} catch {
  if (client) await client.query('ROLLBACK');
  console.error('抽出用テーブルの準備に失敗しました。DB起動状態・権限を確認してください。');
  process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
