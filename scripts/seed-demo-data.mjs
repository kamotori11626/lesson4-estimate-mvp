import { config } from '../src/config.mjs';
import { pool } from '../src/db.mjs';
import { demoCounts, seedDemoData } from '../src/demo-seed.mjs';

try {
  if (!config.demo.dataOnly) throw new Error('DEMO_DATA_ONLY=trueの環境でだけ実行できます。');
  await seedDemoData(pool);
  console.log(JSON.stringify({ ok: true, counts: await demoCounts(pool) }));
} finally { await pool.end(); }
