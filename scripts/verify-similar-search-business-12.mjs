import fs from 'node:fs/promises';
import { pool } from '../src/db.mjs';
import { createSimilarSearchStore } from '../src/similar-search-store.mjs';
import { findCustomerCandidates, findProductCandidates, rankPastQuotes, SEARCH_RULE_VERSION, SEARCH_SCHEMA_VERSION } from '../src/similar-search.mjs';

const benchmarkUrl = new URL('../tests/fixtures/similar-search-business-benchmark-12.json', import.meta.url);
const benchmark = JSON.parse(await fs.readFile(benchmarkUrl, 'utf8'));
const store = createSimilarSearchStore(pool);
const fixedKeys = ['data_as_of', 'differences', 'match_basis', 'quote_id', 'similarity_score', 'source_link'].sort();

function topCandidate(candidates, expectedId) {
  if (!expectedId) return null;
  return candidates.find(candidate => candidate.candidate_id === expectedId) || null;
}

try {
  const data = await store.data();
  const results = benchmark.cases.map(testCase => {
    const customerCandidates = findCustomerCandidates(data.customers, testCase.query.customer_name);
    const productCandidates = findProductCandidates(data.products, testCase.query);
    const selectedCustomer = topCandidate(customerCandidates, testCase.expected_customer_candidate);
    const selectedProduct = topCandidate(productCandidates, testCase.expected_product_candidate);
    const quotes = selectedProduct ? rankPastQuotes(data.quotes, { ...testCase.query, dimensions: null, tolerance: null }, selectedCustomer, selectedProduct, data.data_as_of) : [];
    const top3 = quotes.slice(0, 3);
    const acceptableTop3 = top3.filter(quote => testCase.acceptable_quote_ids.includes(quote.quote_id));
    const entityChecks = {
      customer: testCase.expected_customer_candidate === null
        ? customerCandidates.length === 0
        : customerCandidates[0]?.candidate_id === testCase.expected_customer_candidate,
      product: testCase.expected_product_candidate === null
        ? productCandidates.length === 0
        : productCandidates[0]?.candidate_id === testCase.expected_product_candidate
    };
    let quoteCheck;
    if (testCase.category !== 'no_match') {
      quoteCheck = top3.some(quote => testCase.acceptable_quote_ids.includes(quote.quote_id));
    } else if (testCase.expect_product_only_quotes) {
      quoteCheck = quotes.length > 0 && quotes.every(quote => {
        const customerFactor = quote.match_basis.find(item => item.field === 'customer_name');
        const customerDifference = quote.differences.find(item => item.field === 'customer_name');
        return customerFactor?.points === 0 && customerDifference?.status === 'different';
      });
    } else {
      quoteCheck = quotes.length === 0;
    }
    const formatCheck = quotes.every(quote => JSON.stringify(Object.keys(quote).sort()) === JSON.stringify(fixedKeys));
    return {
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      review_basis: testCase.review_basis,
      expected: {
        customer_candidate: testCase.expected_customer_candidate,
        product_candidate: testCase.expected_product_candidate,
        acceptable_quote_ids: testCase.acceptable_quote_ids
      },
      observed: {
        customer_top: customerCandidates[0]?.candidate_id || null,
        product_top: productCandidates[0]?.candidate_id || null,
        quote_top3: top3.map(quote => ({ quote_id: quote.quote_id, score: quote.similarity_score })),
        acceptable_quote_hits_in_top3: acceptableTop3.map(quote => quote.quote_id),
        quote_count: quotes.length
      },
      checks: { ...entityChecks, quote: quoteCheck, fixed_output: formatCheck },
      pass: entityChecks.customer && entityChecks.product && quoteCheck && formatCheck
    };
  });
  const categorySummary = Object.fromEntries(['exact', 'variant', 'no_match', 'multiple'].map(category => {
    const selected = results.filter(result => result.category === category);
    return [category, { passed: selected.filter(result => result.pass).length, total: selected.length }];
  }));
  const labeledQuoteCases = results.filter(result => result.category !== 'no_match');
  const multipleCases = results.filter(result => result.category === 'multiple');
  const multipleExpectedCount = multipleCases.reduce((sum, result) => sum + result.expected.acceptable_quote_ids.length, 0);
  const multipleHitCount = multipleCases.reduce((sum, result) => sum + result.observed.acceptable_quote_hits_in_top3.length, 0);
  const report = {
    checked_at: new Date().toISOString(),
    schema_version: SEARCH_SCHEMA_VERSION,
    rule_version: SEARCH_RULE_VERSION,
    label_version: benchmark.label_version,
    label_status: benchmark.label_status,
    label_reviewer_role: benchmark.label_reviewer_role,
    business_owner_approval_applicable: benchmark.business_owner_approval_applicable,
    course_exercise_accepted_by_user: benchmark.course_exercise_accepted_by_user,
    label_policy: benchmark.label_policy,
    data_as_of: data.data_as_of,
    source_counts: { customers: data.customers.length, products: data.products.length, quotes: data.quotes.length },
    external_ai_calls: 0,
    category_summary: categorySummary,
    top3_hit_rate: {
      numerator: labeledQuoteCases.filter(result => result.checks.quote).length,
      denominator: labeledQuoteCases.length,
      percent: Math.round(1000 * labeledQuoteCases.filter(result => result.checks.quote).length / labeledQuoteCases.length) / 10
    },
    multiple_label_coverage_in_top3: {
      numerator: multipleHitCount,
      denominator: multipleExpectedCount,
      percent: Math.round(1000 * multipleHitCount / multipleExpectedCount) / 10,
      note: '合否基準は各ケースで許容正解が1件以上Top 3に入ること。これは補助指標として許容正解集合の被覆率を示す。'
    },
    results,
    passed: results.every(result => result.pass)
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await pool.end();
}
