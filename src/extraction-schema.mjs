export const SCHEMA_VERSION = 'extraction-1.0';
export const PROMPT_VERSION = 'extraction-prompt-1.3';
export const RULE_VERSION = 'extraction-rules-1.3';
export const MAX_TEXT_LENGTH = 10_000;
export const FIELD_LABELS = Object.freeze({
  customer_name: '顧客名', product_name: '品名', product_code: '品番', quantity: '数量',
  quantity_unit: '数量単位', material: '材質', dimensions: '寸法', tolerance: '公差',
  requested_delivery_date: '希望納期'
});
export const MODEL_FIELDS = Object.keys(FIELD_LABELS).filter(key => key !== 'customer_name');

const nullableText = { type: ['string', 'null'], maxLength: 1000 };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const valueSchema = key => key === 'quantity'
  ? { type: ['number', 'null'] } : nullableText;

// Human state, request IDs and audit IDs never come from the model.
export const MODEL_SCHEMA = object({
  scope: { type: 'string', enum: ['single', 'multiple', 'out_of_scope', 'uncertain'],
    description: '依頼全体の範囲。商品数と見積依頼としての業務範囲だけで判定する。個別項目の不足・曖昧さではuncertainにしない。' },
  fields: object(Object.fromEntries(MODEL_FIELDS.map(key => [key, object({
    value: valueSchema(key), source_quote: nullableText,
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    ambiguous: { type: 'boolean', description: 'この項目に原文上の複数解釈・矛盾・不明の記述があるときだけtrue。単なる未記載はfalse。trueなら項目との対応が分かる原文引用を必須とする。依頼全体のscopeとは分ける。' }, candidate: nullableText
  })])))
});

export const OUTPUT_SCHEMA = object({
  schema_version: { type: 'string', enum: [SCHEMA_VERSION] },
  request_id: { type: 'string' },
  status: { type: 'string', enum: ['processing', 'needs_review', 'confirmed', 'error'] },
  extracted_fields: object(Object.fromEntries(Object.keys(FIELD_LABELS).map(key => [key, object({
    value: valueSchema(key), source_quote: nullableText,
    source_location: { anyOf: [{ type: 'null' }, object({
      source_id: { type: 'string', enum: ['request_text', 'customer_name'] },
      start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 }
    })] },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    human_status: { type: 'string', enum: ['pending', 'confirmed', 'corrected', 'rejected'] }
  })]))),
  missing_fields: { type: 'array', items: object({
    field_name: { type: 'string', enum: Object.keys(FIELD_LABELS) }, reason: { type: 'string' },
    severity: { type: 'string', enum: ['info', 'warning', 'hold'] }
  }) },
  warnings_and_holds: { type: 'array', items: object({
    code: { type: 'string' }, severity: { type: 'string', enum: ['info', 'warning', 'hold'] },
    message: { type: 'string' }, source: { type: 'string' }, required_action: { type: 'string' }
  }) },
  audit_log_id: { type: ['string', 'null'] }
});

// Validator for the deliberately small JSON Schema subset used above.
// No coercion, unknown keys or silently dropped output fields.
export function matchesSchema(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(s => matchesSchema(value, s));
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matchesType = type => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === type;
  if (!types.some(matchesType)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum)
    || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (typeof value === 'string' && schema.maxLength && value.length > schema.maxLength) return false;
  if (Array.isArray(value)) return value.every(v => matchesSchema(v, schema.items));
  if (value !== null && typeof value === 'object') {
    if (schema.required.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(value).every(([key, v]) => matchesSchema(v, schema.properties[key]));
  }
  return true;
}

export function blankModel(scope = 'single') {
  return { scope, fields: Object.fromEntries(MODEL_FIELDS.map(key => [key, {
    value: null, source_quote: null, confidence: null, ambiguous: false, candidate: null
  }])) };
}
