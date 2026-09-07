import pg from 'pg';
import { config } from './config.mjs';

export const pool = new pg.Pool({
  ...config.pg,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000
});

export async function verifyDatabase() {
  const result = await pool.query('SELECT current_database() AS database, current_user AS user, now() AS checked_at');
  return result.rows[0];
}

export function createPool(pgConfig) {
  return new pg.Pool({ ...pgConfig, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
}

export async function getCounts() {
  const result = await pool.query(`
    SELECT '顧客マスタ' AS label, count(*)::integer AS count FROM customer_master_raw
    UNION ALL SELECT '商品マスタ', count(*)::integer FROM product_master_raw
    UNION ALL SELECT '過去見積履歴', count(*)::integer FROM past_quote_raw
    UNION ALL SELECT '見積依頼ログ', count(*)::integer FROM quote_request_log_raw
    UNION ALL SELECT '外注先マスタ', count(*)::integer FROM supplier_master_raw
    ORDER BY label
  `);
  return result.rows;
}

export async function searchEntities(type, query) {
  const normalized = normalizeForSearch(query);
  const result = await pool.query(`
    SELECT entity_type, entity_id, display_name, source_row_no, source_payload,
      CASE
        WHEN normalized_name = $2 THEN 3
        WHEN normalized_name ILIKE '%' || $2 || '%' THEN 2
        WHEN search_text ILIKE '%' || $2 || '%' THEN 1
        ELSE greatest(similarity(normalized_name, $2), similarity(search_text, $2))
      END AS score
    FROM entity_search
    WHERE entity_type = $1
      AND (normalized_name % $2 OR search_text % $2 OR search_text ILIKE '%' || $2 || '%')
    ORDER BY score DESC, entity_id
    LIMIT 20
  `, [type, normalized]);
  return result.rows;
}

export async function writeCheck() {
  const result = await pool.query(`
    INSERT INTO environment_write_checks (check_label)
    VALUES ('ui-api-db-write-read')
    RETURNING id, checked_at, check_label
  `);
  return result.rows[0];
}

export function normalizeForSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^(旧[:：]|株式会社|有限会社)/, '')
    .replace(/(株式会社|有限会社|co\.?[,]?\s*ltd\.?)$/i, '')
    .replace(/[\s\-ー_・.,，．()（）]/g, '');
}
