// Kept for compatibility. The supported command is `npm run db:load`.
import { config } from '../src/config.mjs';
import { pool } from '../src/db.mjs';
import { demoCounts, seedDemoData } from '../src/demo-seed.mjs';
import { migrateDatabase } from '../src/migrate.mjs';

if (!config.demo.dataOnly) throw new Error('DEMO_DATA_ONLY=trueの環境でだけ実行できます。');
await migrateDatabase(pool);
await seedDemoData(pool);
console.log(JSON.stringify({ ok: true, counts: await demoCounts(pool) }));
await pool.end();

/* Legacy implementation retained below for source-history reference only.
const definitions = [
  {
    file: '19_顧客マスタ.csv', table: 'customer_master_raw', type: 'customer', id: 'customer_id', name: 'customer_name',
    columns: ['customer_id', 'customer_name', 'billing_name', 'delivery_site', 'sales_rep', 'payment_terms', 'closing_date', 'special_discount_rule', 'credit_rank']
  },
  {
    file: '20_商品マスタ.csv', table: 'product_master_raw', type: 'product', id: 'product_id', name: '商品名',
    columns: ['product_id', '品番', '商品名', '材質', '単位', '廃番フラグ', '備考'],
    dbColumns: ['product_id', 'product_code', 'product_name', 'material', 'unit', 'discontinued_flag', 'note']
  },
  {
    file: '18_過去見積履歴.csv', table: 'past_quote_raw', type: 'quote', id: 'quote_no', name: 'quote_no',
    columns: ['quote_no', 'quote_date', 'customer_name', 'product_code', 'material', 'process_type', 'quantity', 'quote_price', 'cost_estimate', 'gross_margin_rate', 'approved_by', 'approval_reason', 'note', 'drawing_link']
  },
  {
    file: '12_見積依頼ログ.csv', table: 'quote_request_log_raw', type: 'request', id: 'rfq_id', name: 'product_text',
    columns: ['rfq_id', 'received_date', 'customer_name', 'sales_rep', 'request_channel', 'product_text', 'quantity', 'requested_delivery_date', 'has_drawing', 'missing_info_flag', 'quote_submitted_date', 'quote_amount', 'gross_margin_rate', 'order_result', 'lost_reason', 'follow_up_done', 'required_tech_review', 'required_supplier_quote']
  },
  {
    file: '15_外注先マスタ.csv', table: 'supplier_master_raw', type: 'supplier', id: 'supplier_id', name: 'supplier_name',
    columns: ['supplier_id', 'supplier_name', 'process_specialty', 'avg_response_days', 'on_time_delivery_rate', 'defect_rate', 'min_lot', 'emergency_available', 'contact_method']
  }
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  return rows;
}

function toObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] === '' ? null : (row[index] ?? null)]));
}

async function loadDefinition(definition) {
  const text = await fs.readFile(path.join(rawDir, definition.file), 'utf8');
  const [headers, ...rows] = parseCsv(text);
  const expected = JSON.stringify(definition.columns);
  if (JSON.stringify(headers) !== expected) {
    throw new Error(`${definition.file}: columns differ. expected=${expected} actual=${JSON.stringify(headers)}`);
  }
  const run = await client.query(
    `INSERT INTO import_runs (source_name, source_row_count, status) VALUES ($1, $2, 'running') RETURNING id`,
    [definition.file, rows.length]
  );
  try {
    await client.query(`TRUNCATE TABLE ${definition.table}`);
    await client.query('DELETE FROM entity_search WHERE entity_type = $1', [definition.type]);
    const dbColumns = definition.dbColumns || definition.columns;
    for (let index = 0; index < rows.length; index += 1) {
      const payload = toObject(headers, rows[index]);
      const values = definition.columns.map(column => payload[column]);
      const placeholders = values.map((_, valueIndex) => `$${valueIndex + 2}`).join(', ');
      await client.query(
        `INSERT INTO ${definition.table} (source_row_no, ${dbColumns.join(', ')}, source_payload)
         VALUES ($1, ${placeholders}, $${values.length + 2})`,
        [index + 2, ...values, payload]
      );
      const displayName = payload[definition.name] || payload[definition.id] || '(名称なし)';
      const searchText = normalizeForSearch(Object.values(payload).filter(Boolean).join(' '));
      await client.query(
        `INSERT INTO entity_search
          (entity_type, entity_id, display_name, normalized_name, search_text, source_row_no, source_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [definition.type, payload[definition.id] || `row-${index + 2}`, displayName, normalizeForSearch(displayName), searchText, index + 2, payload]
      );
    }
    await client.query(`UPDATE import_runs SET status = 'completed', completed_at = now() WHERE id = $1`, [run.rows[0].id]);
    return { file: definition.file, rows: rows.length };
  } catch (error) {
    await client.query(`UPDATE import_runs SET status = 'failed', completed_at = now(), error_message = $2 WHERE id = $1`, [run.rows[0].id, error.message]);
    throw error;
  }
}

await client.connect();
try {
  await client.query(await fs.readFile(schemaPath, 'utf8'));
  await client.query('BEGIN');
  const loaded = [];
  for (const definition of definitions) loaded.push(await loadDefinition(definition));
  await client.query('COMMIT');
  const quality = await client.query('SELECT issue, affected_rows FROM data_quality_summary ORDER BY issue');
  const summary = { loaded_at: new Date().toISOString(), loaded, data_quality: quality.rows };
  await fs.mkdir(processedDir, { recursive: true });
  await fs.writeFile(path.join(processedDir, 'import-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
*/
