const db = require('./db')

const columnCache = new Map()

const normalizeProfile = (row) => {
  if (!row) return null
  return {
    id: row.id,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    is_active: Number(row.is_active || 0) === 1,
    full_name_ru: row.full_name_ru,
    short_name_ru: row.short_name_ru,
    full_name_en: row.full_name_en,
    previous_name_ru: row.previous_name_ru,
    inn: row.inn,
    kpp: row.kpp,
    ogrn: row.ogrn,
    okpo: row.okpo,
    legal_address: row.legal_address,
    tax_office_name: row.tax_office_name,
    tax_office_code: row.tax_office_code,
    tax_registration_date: row.tax_registration_date,
    bank: {
      account_number: row.settlement_account,
      bank_name: row.bank_name,
      bic: row.bic,
      correspondent_account: row.correspondent_account,
    },
    contacts: {
      phones: [row.phone_primary, row.phone_secondary].filter(Boolean),
      edo_sbis: row.edo_sbis,
      edo_diadoc: row.edo_diadoc,
    },
    signer: {
      title_ru: row.signer_title_ru,
      full_name: row.signer_full_name,
      inn: row.signer_inn,
      acting_basis: row.signer_basis_ru,
    },
    registration_change: {
      record_number: row.egrul_record_number,
      change_date: row.change_date,
      reason_ru: row.change_reason_ru,
    },
    notes: row.notes || null,
  }
}

const fetchCurrentCompanyLegalProfile = async (conn = db, effectiveDate = null) => {
  const params = []
  const byDateClause = effectiveDate
    ? `AND effective_from <= ?
       AND (effective_to IS NULL OR effective_to >= ?)`
    : ''
  if (effectiveDate) params.push(effectiveDate, effectiveDate)
  const [[row]] = await conn.execute(
    `SELECT *
       FROM company_legal_profiles
      WHERE is_active = 1
        ${byDateClause}
      ORDER BY effective_from DESC, id DESC
      LIMIT 1`,
    params
  )
  return normalizeProfile(row)
}

const fetchCompanyLegalProfileHistory = async (conn = db) => {
  const [rows] = await conn.execute(
    `SELECT *
       FROM company_legal_profiles
      ORDER BY effective_from DESC, id DESC`
  )
  return rows.map(normalizeProfile)
}

const hasTableColumn = async (conn = db, tableName, columnName) => {
  const key = `${tableName}.${columnName}`
  if (columnCache.has(key)) return columnCache.get(key)
  const [[row]] = await conn.execute(
    `SELECT COUNT(*) AS cnt
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?`,
    [tableName, columnName]
  )
  const exists = Number(row?.cnt || 0) > 0
  columnCache.set(key, exists)
  return exists
}

const parseSnapshot = (raw) => {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch (_err) {
    return null
  }
}

module.exports = {
  normalizeProfile,
  fetchCurrentCompanyLegalProfile,
  fetchCompanyLegalProfileHistory,
  hasTableColumn,
  parseSnapshot,
}
