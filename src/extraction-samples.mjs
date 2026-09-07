// Reconstructed examples, NOT original customer emails. Customer identifiers are fictional.
// Only these exact, server-owned examples may be sent to Gemini in this development step.
export const SAMPLES = Object.freeze([
  {
    id: 'clear', label: '明確な依頼（ログ RFQ-00003 参考）',
    source: '12_見積依頼ログ.csv データ行3（RFQ-00003）の品番・数量・日付を参考に再構成。顧客名は架空。',
    customer_name: '検証用顧客A', received_at: '2025-06-08T09:00:00+09:00',
    request_channel: 'email', case_type: '規格品', item_scope: 'single',
    request_text: '検証用顧客Aです。お見積りをお願いします。\n品番: ALBKT22\n数量: 100個\n希望納期: 2025-06-20\nよろしくお願いいたします。'
  },
  {
    id: 'missing', label: '不足あり（ログ RFQ-00001 参考）',
    source: '12_見積依頼ログ.csv データ行1（RFQ-00001）の品名・数量・日付を参考に再構成。材質等は補完していない。',
    customer_name: '検証用顧客B', received_at: '2026-01-06T09:00:00+09:00',
    request_channel: 'email', case_type: '類似品', item_scope: 'single',
    request_text: '検証用顧客Bです。次の商品の見積をお願いします。\n品名: PPSカバー80\n数量: 1個\n公差: 不明\n希望納期: 2026-02-08'
  },
  {
    id: 'ambiguous', label: '曖昧な納期（ログ RFQ-00004 を加工）',
    source: '12_見積依頼ログ.csv データ行4（RFQ-00004）の商品表現・数量を参考に再構成。納期と単位は試験用に作成。',
    customer_name: '検証用顧客C', received_at: '2025-11-03T09:00:00+09:00',
    request_channel: 'email', case_type: '類似品', item_scope: 'single',
    request_text: '検証用顧客Cです。前回同様のお見積りをお願いします。\n品名: MCナイロンプレート300\n数量: 1枚\n希望納期: 来月半ば\n寸法と公差は前回同様です。'
  },
  {
    id: 'multiple', label: '複数商品 → 全体を保留（架空例）', source: '単一商品制限を試すための架空例。',
    customer_name: '検証用顧客D', received_at: '2026-01-06T09:00:00+09:00',
    request_channel: 'email', case_type: '規格品', item_scope: 'multiple',
    request_text: '検証用顧客Dです。次の2商品の見積をお願いします。\n品番: TEST-A\n数量: 10個\n品番: TEST-B\n数量: 20個'
  },
  {
    id: 'unrelated', label: '業務外 → 対象外（架空例）', source: '見積業務以外の依頼を試すための架空例。',
    customer_name: '検証用顧客E', received_at: '2026-01-06T09:00:00+09:00',
    request_channel: 'email', case_type: '規格品', item_scope: 'unknown',
    request_text: '検証用顧客Eです。明日の天気と、おすすめの観光地を教えてください。'
  }
]);

export function matchingSample(input) {
  return SAMPLES.find(sample => ['customer_name', 'received_at', 'request_channel', 'case_type', 'item_scope', 'request_text']
    .every(key => sample[key] === input[key]));
}
