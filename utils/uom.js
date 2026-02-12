const MAP = {
  pcs: 'pcs', piece: 'pcs', pc: 'pcs', шт: 'pcs', 'штук': 'pcs', 'шт.': 'pcs',
  kg: 'kg', kilogram: 'kg', kilo: 'kg', кг: 'kg', 'кг.': 'kg',
  set: 'set', комплект: 'set', 'компл': 'set', 'компл.': 'set'
}

function normalizeUom(value, { allowEmpty = true } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { uom: allowEmpty ? null : undefined, error: null }
  }
  const key = String(value).trim().toLowerCase()
  const mapped = MAP[key]
  if (mapped) return { uom: mapped, error: null }
  return { uom: null, error: `Некорректная единица измерения: ${value}` }
}

module.exports = { normalizeUom }
