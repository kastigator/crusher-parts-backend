const POLICY_ID = 'wave0-staging-mask-v1'

const RULES = Object.freeze({
  preserve_key: 'preserve_key',
  purge_auth_session: 'purge_auth_session',
  recursive_json: 'recursive_json',
  remove_document_ref: 'remove_document_ref',
  scale_commercial: 'scale_commercial',
  pseudonym_commercial_id: 'pseudonym_commercial_id',
  pseudonym_email: 'pseudonym_email',
  pseudonym_phone: 'pseudonym_phone',
  pseudonym_name: 'pseudonym_name',
  pseudonym_address: 'pseudonym_address',
  pseudonym_bank_legal: 'pseudonym_bank_legal',
  invalidate_secret: 'invalidate_secret',
  redact_text: 'redact_text',
  preserve: 'preserve',
})

const AUTH_SESSION_TABLE = /(^|_)(sessions?|refresh_tokens?|password_resets?|magic_links?|login_tokens?|verification_tokens?)(_|$)/i
const DOCUMENT_REF = /(file|document|attachment|photo|image|object|bucket|storage).*(url|uri|path|key|name|ref)|(^|_)(file_url|document_url|object_path|storage_path)(_|$)/i
const MONEY = /(^|_)(price|cost|amount|total|subtotal|revenue|margin|profit|fee|freight|customs_value|unit_price)(_|$)/i
const COMMERCIAL_ID = /(^|_)(quote|contract|order|rfq|request|invoice|offer|po)_(number|no|code|reference)(_|$)/i
const EMAIL = /(^|_)(email|e_mail)(_|$)/i
const PHONE = /(^|_)(phone|mobile|fax|telegram|whatsapp)(_|$)/i
const ADDRESS = /(^|_)(address|street|house|building|entrance|postal|postcode|city|region|country|latitude|longitude|lat|lng)(_|$)/i
const BANK_LEGAL = /(^|_)(bank|bic|bik|iban|swift|account|inn|kpp|ogrn|tax_id|registration_number|passport|identity|birth|vat_number)(_|$)/i
const SECRET = /(^|_)(password|passwd|secret|token|api_key|credential|cookie|salt|hash)(_|$)/i
const FREE_TEXT = /(^|_)(notes?|comments?|message|description|contact_person|representative)(_|$)/i
const NAME = /(^|_)(name|full_name|first_name|last_name|middle_name|legal_name|company_name)(_|$)/i
const SENSITIVE_HINT = /(personal|private|confidential|pii|gdpr|maiden|national_id|social_security|ssn|email|phone|address|passport|bank|account|token|secret|password|credential|contact|name)/i

const isNumeric = (column) => /(decimal|numeric|float|double|real|int|bigint)/i.test(column.dataType || column.columnType || '')

const classifyColumn = (table, column) => {
  const name = column.name
  if (column.isPrimary || column.isForeign) return RULES.preserve_key
  if (/json/i.test(column.dataType || column.columnType || '')) return RULES.recursive_json
  if (/(document|file|attachment|upload)/i.test(table.name) && /(^|_)(url|uri|path|key|name|ref|bucket)(_|$)/i.test(name)) {
    return RULES.remove_document_ref
  }
  if (DOCUMENT_REF.test(name)) return RULES.remove_document_ref
  if (MONEY.test(name) && isNumeric(column)) return RULES.scale_commercial
  if (COMMERCIAL_ID.test(name)) return RULES.pseudonym_commercial_id
  if (EMAIL.test(name)) return RULES.pseudonym_email
  if (PHONE.test(name)) return RULES.pseudonym_phone
  if (ADDRESS.test(name)) return RULES.pseudonym_address
  if (BANK_LEGAL.test(name)) return RULES.pseudonym_bank_legal
  if (SECRET.test(name)) return RULES.invalidate_secret
  if (FREE_TEXT.test(name)) return RULES.redact_text
  if (NAME.test(name) && /(client|supplier|customer|contact|user|employee|company|legal|organization|counterparty)/i.test(table.name)) {
    return RULES.pseudonym_name
  }
  if (SENSITIVE_HINT.test(name)) {
    throw new Error(`Sensitive-looking column has no masking rule: ${table.name}.${name}`)
  }
  return RULES.preserve
}

const planTable = (table) => {
  if (AUTH_SESSION_TABLE.test(table.name)) {
    return { table: table.name, action: RULES.purge_auth_session, primaryKey: table.primaryKey || [], columns: [] }
  }
  const columns = table.columns.map((column) => ({
    column: column.name,
    rule: classifyColumn(table, column),
    nullable: Boolean(column.isNullable),
  }))
  const changesRows = columns.some(({ rule }) => ![RULES.preserve, RULES.preserve_key].includes(rule))
  if (changesRows && !(table.primaryKey || []).length) {
    throw new Error(`Table requires masking but has no primary key: ${table.name}`)
  }
  return { table: table.name, action: 'transform', primaryKey: table.primaryKey || [], columns }
}

const buildMaskingPlan = (schema) => ({
  policyId: POLICY_ID,
  tables: schema.tables.map(planTable),
})

module.exports = {
  POLICY_ID,
  RULES,
  SENSITIVE_HINT,
  buildMaskingPlan,
  classifyColumn,
}
