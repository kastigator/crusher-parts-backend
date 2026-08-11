const db = require('../../utils/db')
const { normalizeCode } = require('../../utils/uom')

const cleanToken = (value) => {
  if (value === undefined || value === null) return null
  const token = String(value).trim()
  return token || null
}

const buildMeasurementUnitIndex = (units = []) => {
  const byCode = new Map()
  for (const unit of units) {
    const code = normalizeCode(unit.code)
    if (code) byCode.set(code, unit)
  }
  return { units, byCode }
}

const loadMeasurementUnitIndex = async (executor = db) => {
  const [units] = await executor.execute(
    `SELECT id, code, name_ru, name_en, symbol, dimension_type, is_active
       FROM measurement_units
      ORDER BY dimension_type, code`
  )
  return buildMeasurementUnitIndex(units || [])
}

const resolveCanonicalMeasurementUnit = (value, index, { defaultCode = null } = {}) => {
  const originalToken = cleanToken(value)
  const effectiveToken = originalToken || cleanToken(defaultCode)
  const normalizedCode = normalizeCode(effectiveToken)
  if (!normalizedCode) {
    return {
      original_uom: originalToken,
      normalized_uom: null,
      uom: null,
      measurement_unit_id: null,
      error: { code: 'MISSING_UOM', message: 'Укажите единицу измерения' },
    }
  }
  const unit = index?.byCode?.get(normalizedCode) || null
  if (!unit) {
    return {
      original_uom: originalToken,
      normalized_uom: normalizedCode,
      uom: null,
      measurement_unit_id: null,
      error: {
        code: 'UOM_NOT_IN_DICTIONARY',
        message: `Единица «${effectiveToken}» не найдена в справочнике. Выберите существующую единицу.`,
      },
    }
  }
  if (!Number(unit.is_active)) {
    return {
      original_uom: originalToken,
      normalized_uom: normalizedCode,
      uom: null,
      measurement_unit_id: Number(unit.id),
      error: {
        code: 'UOM_INACTIVE',
        message: `Единица «${unit.code}» неактивна. Выберите активную единицу.`,
      },
    }
  }
  return {
    original_uom: originalToken,
    normalized_uom: normalizedCode,
    uom: unit.code,
    measurement_unit_id: Number(unit.id),
    unit: {
      id: Number(unit.id),
      code: unit.code,
      name_ru: unit.name_ru || null,
      symbol: unit.symbol || null,
      dimension_type: unit.dimension_type || null,
    },
    warning: originalToken && normalizeCode(originalToken) === unit.code && originalToken !== unit.code
      ? { code: 'UOM_ALIAS_NORMALIZED', message: `«${originalToken}» нормализовано в «${unit.code}»` }
      : null,
    error: null,
  }
}

module.exports = {
  buildMeasurementUnitIndex,
  loadMeasurementUnitIndex,
  resolveCanonicalMeasurementUnit,
}
