import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeForSearch } from './db.mjs';
import { projectDir } from './config.mjs';

const rawDir = path.join(projectDir, 'data', 'raw');

export const DEMO_DEFINITIONS = Object.freeze([
  { file: '19_顧客マスタ.csv', table: 'customer_master_raw', type: 'customer', id: 'customer_id', name: 'customer_name',
    columns: ['customer_id','customer_name','billing_name','delivery_site','sales_rep','payment_terms','closing_date','special_discount_rule','credit_rank'] },
  { file: '20_商品マスタ.csv', table: 'product_master_raw', type: 'product', id: 'product_id', name: '商品名',
    columns: ['product_id','品番','商品名','材質','単位','廃番フラグ','備考'],
    dbColumns: ['product_id','product_code','product_name','material','unit','discontinued_flag','note'] },
  { file: '18_過去見積履歴.csv', table: 'past_quote_raw', type: 'quote', id: 'quote_no', name: 'quote_no',
    columns: ['quote_no','quote_date','customer_name','product_code','material','process_type','quantity','quote_price','cost_estimate','gross_margin_rate','approved_by','approval_reason','note','drawing_link'] },
  { file: '12_見積依頼ログ.csv', table: 'quote_request_log_raw', type: 'request', id: 'rfq_id', name: 'product_text',
    columns: ['rfq_id','received_date','customer_name','sales_rep','request_channel','product_text','quantity','requested_delivery_date','has_drawing','missing_info_flag','quote_submitted_date','quote_amount','gross_margin_rate','order_result','lost_reason','follow_up_done','required_tech_review','required_supplier_quote'] },
  { file: '15_外注先マスタ.csv', table: 'supplier_master_raw', type: 'supplier', id: 'supplier_id', name: 'supplier_name',
    columns: ['supplier_id','supplier_name','process_specialty','avg_response_days','on_time_delivery_rate','defect_rate','min_lot','emergency_available','contact_method'] }
]);

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
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

const toObject = (headers, row) => Object.fromEntries(headers.map((header, index) => [header, row[index] === '' ? null : (row[index] ?? null)]));

async function seedDefinition(client, definition) {
  const text = await fs.readFile(path.join(rawDir, definition.file), 'utf8');
  const [headers, ...rows] = parseCsv(text);
  if (JSON.stringify(headers) !== JSON.stringify(definition.columns)) throw new Error(`${definition.file}: CSVカラムが定義と一致しません。`);
  const run = await client.query(`INSERT INTO import_runs(source_name,source_row_count,status) VALUES($1,$2,'running') RETURNING id`, [definition.file, rows.length]);
  await client.query(`TRUNCATE TABLE ${definition.table}`);
  await client.query('DELETE FROM entity_search WHERE entity_type=$1', [definition.type]);
  const dbColumns = definition.dbColumns || definition.columns;
  for (let index = 0; index < rows.length; index += 1) {
    const payload = toObject(headers, rows[index]);
    const values = definition.columns.map(column => payload[column]);
    const placeholders = values.map((_, valueIndex) => `$${valueIndex + 2}`).join(', ');
    await client.query(`INSERT INTO ${definition.table}(source_row_no,${dbColumns.join(',')},source_payload) VALUES($1,${placeholders},$${values.length + 2})`, [index + 2, ...values, payload]);
    const displayName = payload[definition.name] || payload[definition.id] || '(名称なし)';
    await client.query(`INSERT INTO entity_search(entity_type,entity_id,display_name,normalized_name,search_text,source_row_no,source_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [definition.type, payload[definition.id] || `row-${index + 2}`, displayName,
      normalizeForSearch(displayName), normalizeForSearch(Object.values(payload).filter(Boolean).join(' ')), index + 2, payload]);
  }
  await client.query(`UPDATE import_runs SET status='completed',completed_at=now() WHERE id=$1`, [run.rows[0].id]);
  return { file: definition.file, rows: rows.length };
}

export async function seedDemoData(pool, { actor = null, resetOperations = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const marker = await client.query("SELECT metadata_value FROM app_metadata WHERE metadata_key='dataset_type' FOR UPDATE");
    if (marker.rows[0]?.metadata_value !== 'demo') throw new Error('デモデータ環境ではないため投入・リセットを停止しました。');
    if (resetOperations) {
      await client.query('DELETE FROM approval_email_events');
      await client.query('DELETE FROM approval_email_drafts');
      await client.query('DELETE FROM approval_email_runs');
      await client.query('DELETE FROM similar_search_events');
      await client.query('DELETE FROM similar_search_runs');
      await client.query('DELETE FROM extraction_review_drafts');
      await client.query('DELETE FROM extraction_events');
      await client.query('DELETE FROM extraction_runs');
      await client.query('DELETE FROM environment_write_checks');
    }
    const loaded = [];
    for (const definition of DEMO_DEFINITIONS) loaded.push(await seedDefinition(client, definition));
    await client.query(`INSERT INTO app_metadata(metadata_key,metadata_value,updated_at) VALUES('last_demo_seed_at',now()::text,now())
      ON CONFLICT(metadata_key) DO UPDATE SET metadata_value=excluded.metadata_value,updated_at=now()`);
    if (actor) await client.query(`INSERT INTO app_audit_events(actor_username,actor_display_name,event_type,event_summary)
      VALUES($1,$2,'demo_data_reset',$3::jsonb)`, [actor.username, actor.displayName,
      JSON.stringify({ scope: ['5 CSV由来マスタ・履歴の再投入','抽出・名寄せ・承認・下書き・書込確認の操作記録を削除'], preserved: ['認証セッション','監査ログ','CSV原本'] })]);
    await client.query('COMMIT');
    return loaded;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function demoCounts(pool) {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*)::integer FROM customer_master_raw) AS customers,
    (SELECT count(*)::integer FROM product_master_raw) AS products,
    (SELECT count(*)::integer FROM past_quote_raw) AS quotes,
    (SELECT count(*)::integer FROM quote_request_log_raw) AS requests,
    (SELECT count(*)::integer FROM supplier_master_raw) AS suppliers`);
  return rows[0];
}
