// Conservative, whole-text proof for the supported labelled single-item format.
// This is NOT a general natural-language item counter or a model-scope override.
import { FIELD_ALIASES, fieldContexts } from './extraction-evidence.mjs';

export const ITEM_SCOPE_RULE = 'single-item-envelope-1';
const labels = [...new Set(Object.values(FIELD_ALIASES).flat())].sort((a, b) => b.length - a.length).join('|');
const fieldLine = new RegExp(`^((?:${labels})(?:\\s*(?:と|・|及び|および)\\s*(?:${labels}))*)\\s*[:：=＝は]\\s*(.*)$`, 'u');
const unsure = /^(?:不明|未定|未記載|要相談|前回同様|前回と同じ|同上)(?:です)?$/u;
const identityUnknown = /不明|未定|前回|同上|一式|内訳|添付|別紙|セット|その他|ほか/;
const simpleIdentity = value => /^[\p{L}\p{N}_.-]+$/u.test(value) && !/と|及び|および/.test(value) && !identityUnknown.test(value);
const purpose = /^(?:(?:次の|以下の)(?:商品の)?|前回同様の)?お?見積(?:もり|り)?(?:を(?:お願いします|お願いいたします|ください)|依頼(?:です)?)$/u;
const closing = /^(?:よろしく)?お願い(?:いた)?します$/u;
const specValue = /^[A-Za-z0-9\s+\-±φΦØø×*/().μ°_%]+$/u;
const quantityValue = /^[+-]?\d[\d,]*(?:\.\d+)?\s*(?:セット|個|本|枚|台|組|式|箱|袋|kg|mm|g|m)?$/u;

function supportedValue(names, raw) {
  const value = raw.normalize('NFKC').trim();
  if (raw.length > 900) return false; // Leave room for the label within the 1000-char quote schema.
  if (/\b(?:and|or)\b/i.test(value)) return false;
  if (names.some(n => ['品番', '品名', '商品名'].includes(n))) return names.length === 1 && simpleIdentity(value);
  if (!value || unsure.test(value)) return true;
  if (names.length > 1) return names.every(n => ['寸法', '公差'].includes(n)) && specValue.test(value);
  if (names[0] === '数量') return quantityValue.test(value);
  if (names[0] === '単位') return /^(?:セット|個|本|枚|台|組|式|箱|袋|kg|mm|g|m)$/u.test(value);
  if (['希望納期', '納期'].includes(names[0])) return /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?$/u.test(value)
    || /^(?:来月|来週|今月|今週)(?:の)?(?:上旬|中旬|下旬|半ば|末|初め|\d{1,2}日)(?:頃|ごろ)?$/u.test(value);
  return specValue.test(value);
}

function evidence(text, start, end, kind) {
  return { kind, source_quote: text.slice(start, end), source_location: { source_id: 'request_text', start, end } };
}

export function assessSingleItem(input) {
  const result = { rule: ITEM_SCOPE_RULE, classification: 'unproven', reason: 'INPUT_ITEM_COUNT_UNCONFIRMED', evidence: [] };
  if (input.item_scope !== 'single') return result;
  const text = input.request_text;
  const counts = new Map();
  let identities = 0;
  // Every nonempty sentence/line must be understood. Unknown prose is never discarded.
  for (const part of text.matchAll(/[^\r\n。]+/gu)) {
    const sentence = part[0].trim();
    if (!sentence) continue;
    const start = part.index + part[0].indexOf(sentence), end = start + sentence.length;
    const hit = fieldLine.exec(sentence);
    if (hit) {
      const names = hit[1].split(/\s*(?:と|・|及び|および)\s*/u);
      const canonical = names.map(n => n === '商品名' ? '品名' : n === '素材' ? '材質' : n === '納期' ? '希望納期' : n);
      for (const name of canonical) counts.set(name, (counts.get(name) || 0) + 1);
      if (canonical.some(n => counts.get(n) > 1)) return { ...result, reason: 'REPEATED_LABEL' };
      if (!supportedValue(names, hit[2])) return { ...result, reason: 'UNSUPPORTED_FIELD_CONTENT' };
      if (canonical.some(n => ['品番', '品名'].includes(n))) identities++;
      result.evidence.push(evidence(text, start, end, canonical.some(n => ['品番', '品名'].includes(n)) ? 'item_identity' : 'item_field'));
    } else if (sentence === `${input.customer_name}です` || purpose.test(sentence) || closing.test(sentence)) {
      result.evidence.push(evidence(text, start, end, 'envelope'));
    } else return { ...result, reason: 'UNSUPPORTED_TEXT' };
  }
  if (!identities) return { ...result, reason: 'NO_EXPLICIT_ITEM_IDENTITY' };
  return { ...result, classification: 'single_labelled', reason: 'WHOLE_TEXT_SINGLE_ITEM_ENVELOPE' };
}

// Additional fail-closed signals; distinct from unknown/relative specification values.
export function itemScopeRisk(input) {
  const text = input.request_text.normalize('NFKC');
  if ([...text.matchAll(/(?<!\d)(\d+)\s*(?:商品|品目|種類)/gu)].some(m => Number(m[1]) > 1)
    || /[二三四五六七八九十]品目|[二三四五六七八九十]商品/.test(text)) return 'multiple';
  const codes = fieldContexts(text, 'product_code'), names = fieldContexts(text, 'product_name');
  if (codes.length > 1 || names.length > 1) return 'multiple';
  const identities = [...codes, ...names];
  if (identities.some(c => /[/／、,，&＆]|または|もしくは|及び|および|と/.test(c.value_text)
    || identityUnknown.test(c.value_text))) return 'uncertain';
  if ((!identities.length && /前回|一式|内訳|同上|別紙|添付/.test(text))
    || /(?:別の|別途|追加の|その他の|ほかの)(?:商品|部品)|(?:ほか|他)にも.*(?:見積|部品|商品)/.test(text)) return 'uncertain';
  return null;
}
