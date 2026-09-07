import { pool } from '../src/db.mjs';
import { createSimilarSearchStore } from '../src/similar-search-store.mjs';
import { findCustomerCandidates, findProductCandidates, rankPastQuotes, SEARCH_RULE_VERSION, SEARCH_SCHEMA_VERSION, SEARCH_TEST_QUERIES } from '../src/similar-search.mjs';

const store = createSimilarSearchStore(pool);
try {
  const data = await store.data();
  const cases = SEARCH_TEST_QUERIES.map(query => {
    const customers = findCustomerCandidates(data.customers, query.customer_name);
    const products = findProductCandidates(data.products, query);
    const quotes = products.length ? rankPastQuotes(data.quotes, { ...query, dimensions: null, tolerance: null }, customers[0] || null, products[0], data.data_as_of) : [];
    return { id: query.id, query, customer_top: customers[0] ? { candidate_id: customers[0].candidate_id, score: customers[0].similarity_score, members: customers[0].member_count } : null,
      product_top: products[0] ? { candidate_id: products[0].candidate_id, score: products[0].similarity_score, members: products[0].member_count } : null,
      quote_count: quotes.length, quote_top: quotes[0] ? { quote_id: quotes[0].quote_id, score: quotes[0].similarity_score,
        basis: quotes[0].match_basis.map(item => `${item.field}:${item.points}`), differences: quotes[0].differences.filter(item => item.status !== 'same').map(item => `${item.field}:${item.status}`) } : null,
      fixed_quote_keys: quotes.every(quote => JSON.stringify(Object.keys(quote).sort()) === JSON.stringify(['data_as_of','differences','match_basis','quote_id','similarity_score','source_link'].sort())) };
  });
  const checks = [
    { name: '完全一致の顧客・商品が1位', pass: cases[0].customer_top?.score === 100 && cases[0].product_top?.candidate_id === 'product:POM1208' },
    { name: '表記ゆれの顧客・商品が1位', pass: cases[1].customer_top?.candidate_id === 'customer:アサヒ食品機械' && cases[1].product_top?.candidate_id === 'product:POM1208' },
    { name: '未知データは候補なし', pass: cases[2].customer_top === null && cases[2].product_top === null && cases[2].quote_count === 0 },
    { name: '複数の過去見積を最大5件提示', pass: cases[3].quote_count > 1 && cases[3].quote_count <= 5 },
    { name: '全過去見積候補が固定6キー', pass: cases.filter(item => item.quote_count).every(item => item.fixed_quote_keys) }
  ];
  console.log(JSON.stringify({ checked_at: new Date().toISOString(), schema_version: SEARCH_SCHEMA_VERSION,
    rule_version: SEARCH_RULE_VERSION, data_as_of: data.data_as_of, source_counts: { customers: data.customers.length, products: data.products.length, quotes: data.quotes.length },
    external_ai_calls: 0, cases, checks, passed: checks.every(check => check.pass) }, null, 2));
} finally { await pool.end(); }

