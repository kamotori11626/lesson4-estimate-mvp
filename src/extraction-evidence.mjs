// Deterministic checks on original text. No AI calls, master lookups or inferred values.
export const FIELD_ALIASES = Object.freeze({
  product_name: ['品名', '商品名'], product_code: ['品番'], quantity: ['数量'],
  quantity_unit: ['単位', '数量'], material: ['材質', '素材'],
  dimensions: ['寸法'], tolerance: ['公差'], requested_delivery_date: ['希望納期', '納期']
});
export const AMBIGUITY = /不明|未定|前回|同様|ごろ|頃|ほど|約|来月|来週|上旬|中旬|下旬|半ば|または|もしくは|要相談/;
const CORRECTION = /訂正|変更|修正|誤り|誤\s*[:：]|正\s*[:：]|→|または|もしくは/;
const LABEL = [...new Set(Object.values(FIELD_ALIASES).flat())].sort((a, b) => b.length - a.length).join('|');
const NUMBER = /[+-]?\d[\d,]*(?:\.\d+)?/g;
// Supported spellings, not an assertion that every other business unit is invalid.
export const UNITS = Object.freeze(['セット', '個', '本', '枚', '台', '組', '式', '箱', '袋', 'kg', 'mm', 'g', 'm']);

export function textLocation(text, start, end) {
  return { quote: text.slice(start, end), start, end };
}

export function fieldContexts(text, key) {
  // Only explicitly labelled clauses. Do not infer material from product names.
  const pattern = new RegExp(`(?:^|[\\n。;；])\\s*((?:${LABEL})(?:\\s*(?:と|・|及び|および)\\s*(?:${LABEL}))*)\\s*[:：=＝は]\\s*([^\\n。;；]*)`, 'g');
  const contexts = [];
  for (const match of text.matchAll(pattern)) {
    const labels = match[1].split(/\s*(?:と|・|及び|および)\s*/);
    if (!FIELD_ALIASES[key].some(label => labels.includes(label))) continue;
    const start = match.index + match[0].indexOf(match[1]);
    contexts.push({ ...textLocation(text, start, match.index + match[0].length),
      value_text: match[2].trim(), labels });
  }
  return contexts;
}

export function locateQuote(text, quote, key) {
  if (typeof quote !== 'string' || !quote.length) return null;
  const contexts = fieldContexts(text, key);
  const otherContexts = Object.keys(FIELD_ALIASES).filter(k => k !== key)
    .flatMap(k => fieldContexts(text, k));
  let first = null;
  for (let start = text.indexOf(quote); start !== -1; start = text.indexOf(quote, start + 1)) {
    const hit = textLocation(text, start, start + quote.length);
    if (contexts.some(c => hit.start >= c.start && hit.end <= c.end)) return hit;
    // Reject a quote that explicitly belongs to a different field (e.g. material from 品名).
    if (!first && !otherContexts.some(c => hit.start >= c.start && hit.end <= c.end)) first = hit;
  }
  return first;
}

export function numbers(text) {
  return [...text.normalize('NFKC').matchAll(NUMBER)].map(m => Number(m[0].replaceAll(',', '')));
}

export function explicitDate(text) {
  const match = text.normalize('NFKC').match(/(?<!\d)(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?!\d)/);
  if (!match) return null;
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

export function unitInQuote(value, quote) {
  if (typeof value !== 'string' || typeof quote !== 'string') return false;
  const unit = value.normalize('NFKC');
  if (!UNITS.includes(unit)) return false;
  const source = quote.normalize('NFKC').trim();
  if (source === unit) return true;
  // The unit must follow a quantity token, not be a substring of another unit.
  const match = source.match(new RegExp(`[+-]?\\d[\\d,]*(?:\\.\\d+)?\\s*(${UNITS.join('|')})(?![A-Za-z])`));
  return match?.[1] === unit;
}

export function inspectField(text, key) {
  const contexts = fieldContexts(text, key);
  const nonempty = contexts.filter(c => c.value_text);
  const distinct = new Set(nonempty.map(c => key === 'quantity_unit'
    ? UNITS.find(unit => unitInQuote(unit, c.value_text))
    : c.value_text.normalize('NFKC').replace(/\s/g, '')).filter(v => v !== undefined));
  const correction = nonempty.some(c => CORRECTION.test(c.value_text));
  const numericConflict = ['quantity', 'quantity_unit'].includes(key)
    && nonempty.some(c => new Set(numbers(c.value_text)).size > 1);
  // Different quantities with the SAME unit are not a contradiction in the unit itself.
  const conflict = distinct.size > 1 || (key !== 'quantity_unit' && (correction || numericConflict));
  if (conflict) {
    const start = contexts[0].start, end = contexts.at(-1).end;
    return { code: 'CONFLICTING_VALUES', evidence: textLocation(text, start, end),
      detail: contexts.map(c => `「${c.quote}」 [${c.start}, ${c.end})`).join(' / ') };
  }
  const ambiguous = nonempty.find(c => AMBIGUITY.test(c.value_text));
  if (ambiguous) return { code: 'AMBIGUOUS', evidence: ambiguous };
  if (key === 'quantity') {
    const invalid = nonempty.find(c => numbers(c.value_text).some(n => n <= 0));
    if (invalid) return { code: 'INVALID_VALUE', evidence: invalid };
  }
  if (key === 'requested_delivery_date') {
    const invalid = nonempty.find(c => /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(c.value_text.normalize('NFKC')) && explicitDate(c.value_text) === null);
    if (invalid) return { code: 'INVALID_VALUE', evidence: invalid };
  }
  return null;
}

export function quantityMentions(text) {
  const quantities = fieldContexts(text, 'quantity');
  const otherFields = ['product_name', 'product_code', 'material', 'dimensions', 'tolerance', 'requested_delivery_date']
    .flatMap(key => fieldContexts(text, key));
  return [...text.matchAll(/[+＋\-－]?[0-9０-９][0-9０-９,，]*(?:[.．][0-9０-９]+)?\s*(セット|個|本|枚|台|組|式|箱|袋|kg|mm|g|m)(?![A-Za-z])/g)]
    .filter(m => !otherFields.some(c => m.index >= c.start && m.index + m[0].length <= c.end)
      && (!/^[a-z]+$/.test(m[1]) || quantities.some(c => m.index >= c.start && m.index + m[0].length <= c.end)))
    .map(m => textLocation(text, m.index, m.index + m[0].length));
}

export function ambiguityIsGrounded(text, key, evidence) {
  if (!evidence || !AMBIGUITY.test(evidence.quote)) return false;
  return fieldContexts(text, key).some(c => evidence.start >= c.start && evidence.end <= c.end)
    || (FIELD_ALIASES[key].some(alias => evidence.quote.includes(alias)) && AMBIGUITY.test(evidence.quote));
}

export function isSingleItemQuantityConflict(input) {
  if (input.item_scope !== 'single' || inspectField(input.request_text, 'quantity')?.code !== 'CONFLICTING_VALUES') return false;
  const identities = ['product_name', 'product_code'].flatMap(key => fieldContexts(input.request_text, key));
  // Only a clearly labelled single identifier/name, not "A/B" or "A、B" etc.
  if (!identities.length || identities.some(c => !/^[\p{L}\p{N}_ -]+$/u.test(c.value_text)
    || /と|及び|および/.test(c.value_text))) return false;
  const quantities = fieldContexts(input.request_text, 'quantity');
  const mentions = quantityMentions(input.request_text);
  return mentions.length > 1 && mentions.every(m => quantities.some(c => m.start >= c.start && m.end <= c.end));
}

export function hasCredential(text) {
  return /\bAIza[\w-]{10,}|-----BEGIN .*PRIVATE KEY-----|\bBearer\s+\S+|(?:api[_ -]?key|password|secret)\s*[:=]/i.test(text.normalize('NFKC'));
}
