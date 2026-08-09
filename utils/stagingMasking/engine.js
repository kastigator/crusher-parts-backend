const crypto = require('node:crypto')
const { POLICY_ID, RULES, SENSITIVE_HINT, buildMaskingPlan, classifyColumn } = require('./policy')

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}
const stableJson = (value) => JSON.stringify(stableValue(value))
const digest = (seed, context, value) => crypto.createHmac('sha256', seed)
  .update(`${context}\u0000${value === null ? '<null>' : String(value)}`)
  .digest('hex')

const commercialFactor = (seed) => 0.7 + (parseInt(digest(seed, 'commercial-factor', 'v1').slice(0, 8), 16) / 0xffffffff) * 0.6

const pseudonym = (seed, context, value, prefix) => `${prefix}${digest(seed, context, value).slice(0, 12)}`

const transformScalar = (rule, value, context) => {
  if (value === null || value === undefined) return value
  const { seed, path, factor, nullable } = context
  switch (rule) {
    case RULES.remove_document_ref: return nullable ? null : ''
    case RULES.scale_commercial: return Number((Number(value) * factor).toFixed(4))
    case RULES.pseudonym_commercial_id: return pseudonym(seed, path, value, 'STAGE-COM-')
    case RULES.pseudonym_email: return `${pseudonym(seed, path, value, 'stage+')}@example.invalid`
    case RULES.pseudonym_phone: return `+7000${parseInt(digest(seed, path, value).slice(0, 10), 16).toString().padStart(10, '0').slice(0, 7)}`
    case RULES.pseudonym_name: return pseudonym(seed, path, value, 'Stage-')
    case RULES.pseudonym_address: return pseudonym(seed, path, value, 'Masked-address-')
    case RULES.pseudonym_bank_legal: return pseudonym(seed, path, value, 'MASKED-')
    case RULES.invalidate_secret: return pseudonym(seed, path, value, '!disabled-')
    case RULES.redact_text: return pseudonym(seed, path, value, '[masked-') + ']'
    default: return value
  }
}

const classifyJsonKey = (key) => {
  if (/^(contact|customer|client|supplier|person|user|bank|address|legal)$/i.test(key)) {
    return RULES.recursive_json
  }
  const fakeTable = { name: 'json_client_contact' }
  const fakeColumn = { name: key, dataType: 'varchar', columnType: 'varchar', isPrimary: false, isForeign: false, isNullable: true }
  try {
    return classifyColumn(fakeTable, fakeColumn)
  } catch (error) {
    if (SENSITIVE_HINT.test(key)) throw error
    return RULES.preserve
  }
}

const transformJson = (value, context) => {
  if (Array.isArray(value)) return value.map((item, index) => transformJson(item, { ...context, path: `${context.path}[${index}]` }))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const path = `${context.path}.${key}`
    const rule = classifyJsonKey(key)
    if (item && typeof item === 'object' && rule === RULES.preserve) {
      return [key, transformJson(item, { ...context, path })]
    }
    if (rule === RULES.recursive_json) return [key, transformJson(item, { ...context, path })]
    return [key, transformScalar(rule, item, { ...context, path, nullable: true })]
  }))
}

const parseJson = (value, path) => {
  if (value === null || value === undefined) return { parsed: value, wasString: false }
  if (typeof value === 'string') {
    try { return { parsed: JSON.parse(value), wasString: true } } catch { throw new Error(`Invalid JSON value at ${path}`) }
  }
  return { parsed: value, wasString: false }
}

const transformRow = (row, tablePlan, seed, factor) => {
  const next = { ...row }
  for (const column of tablePlan.columns) {
    const path = `${tablePlan.table}.${column.column}`
    if (column.rule === RULES.recursive_json) {
      const { parsed, wasString } = parseJson(row[column.column], path)
      const transformed = transformJson(parsed, { seed, factor, path })
      next[column.column] = wasString ? JSON.stringify(transformed) : transformed
    } else {
      next[column.column] = transformScalar(column.rule, row[column.column], {
        seed, factor, path, nullable: column.nullable,
      })
    }
  }
  return next
}

const checksumRows = (seed, rows) => {
  const hmac = crypto.createHmac('sha256', seed)
  rows.forEach((row) => hmac.update(stableJson(row)))
  return hmac.digest('hex')
}

const forbiddenFindings = (value, path, findings, forbiddenLiterals = [], strictSensitive = true) => {
  if (Array.isArray(value)) return value.forEach((item, index) => forbiddenFindings(item, `${path}[${index}]`, findings, forbiddenLiterals, strictSensitive))
  if (value && typeof value === 'object') return Object.entries(value).forEach(([key, item]) => forbiddenFindings(item, `${path}.${key}`, findings, forbiddenLiterals, strictSensitive))
  if (typeof value !== 'string') return
  const commonTests = [
    ['cloud_document_url', /https?:\/\/(storage\.googleapis\.com|[^/]+\.storage\.googleapis\.com)\//i],
    ['jwt_token', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
    ['bearer_token', /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/i],
    ['google_api_key', /\bAIza[A-Za-z0-9_-]{20,}\b/],
    ['credential_assignment', /\b(api[_ -]?key|secret|password|token)\s*[:=]\s*[^\s,;]{8,}/i],
  ]
  const sensitiveTests = [
    ['real_email', /\b[A-Z0-9._%+-]+@(?!example\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ['long_bank_or_card_number', /\b\d{13,20}\b/],
  ]
  const tests = strictSensitive ? [...commonTests, ...sensitiveTests] : commonTests
  tests.forEach(([rule, regex]) => { if (regex.test(value)) findings.push({ path, rule }) })
  forbiddenLiterals.forEach((literal, index) => {
    if (literal && value.toLowerCase().includes(literal.toLowerCase())) {
      findings.push({ path, rule: `configured_production_literal_${index + 1}` })
    }
  })
}

const inventory = async (adapter) => {
  const schema = await adapter.discoverSchema()
  const plan = buildMaskingPlan(schema)
  return { schema, plan }
}

const execute = async (adapter, { mode, seed }) => {
  if (!['dry-run', 'mask'].includes(mode)) throw new Error('mode must be dry-run or mask')
  if (!seed || seed.length < 16) throw new Error('Masking seed must contain at least 16 characters')
  const { plan } = await inventory(adapter)
  const factor = commercialFactor(seed)
  const evidence = { policyId: POLICY_ID, mode, status: 'PASS', tables: [], checks: [] }

  for (const tablePlan of plan.tables) {
    const beforeCount = await adapter.countRows(tablePlan.table)
    if (tablePlan.action === RULES.purge_auth_session) {
      if (mode === 'mask') await adapter.purgeTable(tablePlan.table)
      const afterCount = mode === 'mask' ? 0 : beforeCount
      evidence.tables.push({
        table: tablePlan.table,
        action: tablePlan.action,
        beforeCount,
        afterCount,
        changedRows: beforeCount,
        ruleIds: [RULES.purge_auth_session],
        beforeChecksum: digest(seed, `${tablePlan.table}:row-count`, beforeCount),
        afterChecksum: digest(seed, `${tablePlan.table}:row-count`, afterCount),
      })
      continue
    }

    const changedColumns = tablePlan.columns.filter(({ rule }) => ![RULES.preserve, RULES.preserve_key].includes(rule))
    if (!changedColumns.length) {
      evidence.tables.push({ table: tablePlan.table, action: 'preserve', beforeCount, afterCount: beforeCount, changedRows: 0 })
      continue
    }
    const readColumns = [...new Set([...tablePlan.primaryKey, ...tablePlan.columns.map(({ column }) => column)])]
    const rows = await adapter.readRows(tablePlan.table, readColumns)
    const transformed = rows.map((row) => transformRow(row, tablePlan, seed, factor))
    let changedRows = 0
    for (let index = 0; index < rows.length; index += 1) {
      if (JSON.stringify(rows[index]) === JSON.stringify(transformed[index])) continue
      changedRows += 1
      if (mode === 'mask') await adapter.updateRow(tablePlan.table, tablePlan.primaryKey, rows[index], transformed[index], changedColumns.map(({ column }) => column))
    }
    const afterCount = await adapter.countRows(tablePlan.table)
    if (afterCount !== beforeCount) throw new Error(`Unexpected cardinality change in ${tablePlan.table}`)
    evidence.tables.push({
      table: tablePlan.table,
      action: 'transform',
      beforeCount,
      afterCount,
      changedRows,
      ruleIds: [...new Set(changedColumns.map(({ rule }) => rule))],
      beforeChecksum: checksumRows(seed, rows),
      afterChecksum: checksumRows(seed, transformed),
    })
  }
  evidence.checks.push({ id: 'policy-complete', status: 'PASS' })
  evidence.checks.push({ id: 'cardinality-preserved-except-auth-sessions', status: 'PASS' })
  return evidence
}

const verify = async (adapter, { forbiddenLiterals = [] } = {}) => {
  const { plan } = await inventory(adapter)
  const findings = []
  const checks = []
  for (const tablePlan of plan.tables) {
    const count = await adapter.countRows(tablePlan.table)
    if (tablePlan.action === RULES.purge_auth_session) {
      if (count) findings.push({ path: tablePlan.table, rule: 'auth_session_rows_remain' })
      continue
    }
    const inspectColumns = tablePlan.columns.filter(({ rule }) => rule !== RULES.preserve_key)
    if (!inspectColumns.length) continue
    const rows = await adapter.readRows(tablePlan.table, inspectColumns.map(({ column }) => column))
    rows.forEach((row, index) => inspectColumns.forEach(({ column, rule }) => {
      const value = row[column]
      if (rule === RULES.remove_document_ref && value) findings.push({ path: `${tablePlan.table}.${column}[${index}]`, rule: 'document_ref_remains' })
      if (rule === RULES.recursive_json) {
        const { parsed } = parseJson(value, `${tablePlan.table}.${column}`)
        forbiddenFindings(parsed, `${tablePlan.table}.${column}[${index}]`, findings, forbiddenLiterals, true)
      } else {
        const strictSensitive = ![RULES.preserve, RULES.scale_commercial].includes(rule)
        forbiddenFindings(value, `${tablePlan.table}.${column}[${index}]`, findings, forbiddenLiterals, strictSensitive)
      }
    }))
  }
  const fkViolations = await adapter.foreignKeyViolations()
  if (fkViolations.length) findings.push(...fkViolations.map((item) => ({ ...item, rule: 'foreign_key_violation' })))
  checks.push({ id: 'forbidden-patterns', status: findings.length ? 'FAIL' : 'PASS', findingCount: findings.length })
  checks.push({ id: 'foreign-keys', status: fkViolations.length ? 'FAIL' : 'PASS', findingCount: fkViolations.length })
  return { policyId: POLICY_ID, status: findings.length ? 'FAIL' : 'PASS', checks, findings }
}

module.exports = { commercialFactor, execute, inventory, transformJson, transformRow, verify }
