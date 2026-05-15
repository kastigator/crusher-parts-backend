const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const requireMutationCapability = require('../middleware/requireMutationCapability')

const DIMENSION_TYPES = new Set([
  'quantity',
  'mass',
  'length',
  'area',
  'volume',
  'time',
  'currency',
  'custom',
])

const USAGE_SOURCES = [
  { key: 'oem_parts.uom', label: 'OEM детали', table: 'oem_parts', field: 'uom' },
  { key: 'oem_part_model_fitments.uom', label: 'OEM детали по моделям', table: 'oem_part_model_fitments', field: 'uom' },
  { key: 'standard_parts.uom', label: 'Стандартные детали', table: 'standard_parts', field: 'uom' },
  { key: 'supplier_parts.uom', label: 'Детали поставщиков', table: 'supplier_parts', field: 'uom' },
  { key: 'rfq_items.uom', label: 'RFQ позиции', table: 'rfq_items', field: 'uom' },
  { key: 'rfq_coverage_option_lines.uom', label: 'RFQ coverage', table: 'rfq_coverage_option_lines', field: 'uom' },
  { key: 'client_request_revision_items.uom', label: 'Заявки клиентов', table: 'client_request_revision_items', field: 'uom' },
  { key: 'material_properties.unit', label: 'Свойства материалов', table: 'material_properties', field: 'unit' },
  { key: 'standard_part_class_fields.unit', label: 'Поля классов стандартных деталей', table: 'standard_part_class_fields', field: 'unit' },
  { key: 'rfq_econ2_scenario_other_costs.unit', label: 'Прочие расходы экономики', table: 'rfq_econ2_scenario_other_costs', field: 'unit' },
  { key: 'supplier_procurement_rules.enforce_uom', label: 'Правила закупки поставщика', table: 'supplier_procurement_rules', field: 'enforce_uom' },
]

const UNIT_ALIASES = new Map(
  Object.entries({
    pcs: 'pcs',
    piece: 'pcs',
    pc: 'pcs',
    шт: 'pcs',
    'шт.': 'pcs',
    штук: 'pcs',
    штука: 'pcs',
    штуки: 'pcs',
    set: 'set',
    комплект: 'set',
    компл: 'set',
    'компл.': 'set',
    kg: 'kg',
    kilogram: 'kg',
    кг: 'kg',
    'кг.': 'kg',
    g: 'g',
    gram: 'g',
    г: 'g',
    'г.': 'g',
    t: 't',
    ton: 't',
    tonne: 't',
    т: 't',
    'т.': 't',
    m: 'm',
    метр: 'm',
    м: 'm',
    cm: 'cm',
    сантиметр: 'cm',
    см: 'cm',
    mm: 'mm',
    миллиметр: 'mm',
    мм: 'mm',
    m2: 'm2',
    'm²': 'm2',
    м2: 'm2',
    'м²': 'm2',
    m3: 'm3',
    'm³': 'm3',
    м3: 'm3',
    'м³': 'm3',
    l: 'l',
    liter: 'l',
    litre: 'l',
    л: 'l',
    'л.': 'l',
    day: 'day',
    days: 'day',
    день: 'day',
    дн: 'day',
    'дн.': 'day',
    kw: 'kw',
    kilowatt: 'kw',
    'квт': 'kw',
    'квт.': 'kw',
    v: 'v',
    volt: 'v',
    в: 'v',
    'в.': 'v',
    hz: 'hz',
    hertz: 'hz',
    гц: 'hz',
    'гц.': 'hz',
    rpm: 'rpm',
    'r/min': 'rpm',
    'rev/min': 'rpm',
    'об/мин': 'rpm',
    'об/мин.': 'rpm',
    a: 'a',
    ampere: 'a',
    ампер: 'a',
    а: 'a',
    nm: 'nm',
    'n·m': 'nm',
    'n*m': 'nm',
    'н·м': 'nm',
    'нм': 'nm',
    bar: 'bar',
    бар: 'bar',
    mpa: 'mpa',
    'мпа': 'mpa',
    celsius: 'celsius',
    '°c': 'celsius',
    '℃': 'celsius',
    percent: 'percent',
    '%': 'percent',
    процент: 'percent',
  })
)

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const toBool = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback
  return v === true || v === 1 || v === '1' || v === 'true'
}

const numOrNull = (v) => {
  if (v === '' || v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const normalizeCode = (value) => {
  const s = nz(value)
  if (!s) return null
  return s.toLowerCase()
}

const normalizeUnitValue = (value) => {
  const key = normalizeCode(value)
  if (!key) return null
  return UNIT_ALIASES.get(key) || key
}

const validatePayload = async (payload, { id = null, partial = false } = {}) => {
  const next = {}

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'code')) {
    next.code = normalizeCode(payload.code)
    if (!next.code || !/^[a-z0-9][a-z0-9_-]*$/.test(next.code)) {
      throw Object.assign(new Error('Код единицы должен быть латиницей/цифрами, например pcs, kg, cm'), { status: 400 })
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'name_ru')) {
    next.name_ru = nz(payload.name_ru)
    if (!next.name_ru) {
      throw Object.assign(new Error('Укажите название на русском'), { status: 400 })
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(payload, 'dimension_type')) {
    next.dimension_type = nz(payload.dimension_type) || 'custom'
    if (!DIMENSION_TYPES.has(next.dimension_type)) {
      throw Object.assign(new Error('Некорректный тип измерения'), { status: 400 })
    }
  }

  next.name_en = Object.prototype.hasOwnProperty.call(payload, 'name_en') ? nz(payload.name_en) : undefined
  next.symbol = Object.prototype.hasOwnProperty.call(payload, 'symbol') ? nz(payload.symbol) : undefined
  next.note = Object.prototype.hasOwnProperty.call(payload, 'note') ? nz(payload.note) : undefined
  next.factor_to_base = Object.prototype.hasOwnProperty.call(payload, 'factor_to_base')
    ? numOrNull(payload.factor_to_base)
    : undefined
  next.is_active = Object.prototype.hasOwnProperty.call(payload, 'is_active')
    ? (toBool(payload.is_active, true) ? 1 : 0)
    : undefined

  if (Object.prototype.hasOwnProperty.call(payload, 'base_unit_id')) {
    next.base_unit_id = toId(payload.base_unit_id)
    if (next.base_unit_id && id && next.base_unit_id === id) {
      throw Object.assign(new Error('Базовая единица не может ссылаться сама на себя'), { status: 400 })
    }
    if (next.base_unit_id) {
      const [baseRows] = await db.execute('SELECT id FROM measurement_units WHERE id = ? LIMIT 1', [next.base_unit_id])
      if (!baseRows.length) {
        throw Object.assign(new Error('Базовая единица не найдена'), { status: 400 })
      }
    }
  }

  return next
}

const buildUsageSummary = async () => {
  const [unitRows] = await db.execute('SELECT id, code FROM measurement_units')
  const byCode = new Map(
    (unitRows || []).map((row) => [
      String(row.code || '').toLowerCase(),
      { total: 0, sources: [], raw_values: [] },
    ])
  )
  const unknown = new Map()

  for (const source of USAGE_SOURCES) {
    const [rows] = await db.query(
      `
      SELECT ${source.field} AS raw_value, COUNT(*) AS cnt
      FROM ${source.table}
      WHERE ${source.field} IS NOT NULL
        AND TRIM(${source.field}) <> ''
      GROUP BY ${source.field}
      `
    )

    for (const row of rows || []) {
      const raw = nz(row.raw_value)
      const cnt = Number(row.cnt || 0)
      const code = normalizeUnitValue(raw)
      if (!code || !cnt) continue

      if (byCode.has(code)) {
        const usage = byCode.get(code)
        usage.total += cnt
        usage.sources.push({ key: source.key, label: source.label, count: cnt, raw_value: raw })
        if (raw && raw.toLowerCase() !== code && !usage.raw_values.includes(raw)) {
          usage.raw_values.push(raw)
        }
      } else {
        const existing = unknown.get(raw) || { raw_value: raw, normalized: code, total: 0, sources: [] }
        existing.total += cnt
        existing.sources.push({ key: source.key, label: source.label, count: cnt })
        unknown.set(raw, existing)
      }
    }
  }

  return {
    byCode: Object.fromEntries(byCode.entries()),
    unknown: Array.from(unknown.values()).sort((a, b) => b.total - a.total),
  }
}

router.get('/usage', async (req, res) => {
  try {
    res.json(await buildUsageSummary())
  } catch (err) {
    console.error('❌ Ошибка расчета использования единиц измерения:', err)
    res.status(500).json({ message: 'Ошибка сервера при расчете использования единиц измерения' })
  }
})

router.get('/', async (req, res) => {
  try {
    const where = []
    const params = []

    if (req.query.active !== undefined) {
      where.push('mu.is_active = ?')
      params.push(toBool(req.query.active) ? 1 : 0)
    }

    const dimensionType = nz(req.query.dimension_type)
    if (dimensionType) {
      where.push('mu.dimension_type = ?')
      params.push(dimensionType)
    }

    const q = nz(req.query.q)
    if (q) {
      where.push('(mu.code LIKE ? OR mu.name_ru LIKE ? OR mu.name_en LIKE ? OR mu.symbol LIKE ?)')
      const like = `%${q}%`
      params.push(like, like, like, like)
    }

    const [rows] = await db.execute(
      `
      SELECT
        mu.*,
        base.code AS base_unit_code,
        base.name_ru AS base_unit_name_ru,
        base.symbol AS base_unit_symbol
      FROM measurement_units mu
      LEFT JOIN measurement_units base ON base.id = mu.base_unit_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY mu.dimension_type, mu.code
      `,
      params
    )

    if (toBool(req.query.include_usage)) {
      const usage = await buildUsageSummary()
      return res.json({
        rows: rows.map((row) => ({
          ...row,
          usage: usage.byCode[String(row.code || '').toLowerCase()] || { total: 0, sources: [], raw_values: [] },
        })),
        unknown_units: usage.unknown,
      })
    }

    res.json(rows)
  } catch (err) {
    console.error('❌ Ошибка загрузки единиц измерения:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке единиц измерения' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      `
      SELECT mu.*, base.code AS base_unit_code, base.name_ru AS base_unit_name_ru, base.symbol AS base_unit_symbol
      FROM measurement_units mu
      LEFT JOIN measurement_units base ON base.id = mu.base_unit_id
      WHERE mu.id = ?
      LIMIT 1
      `,
      [id]
    )
    if (!rows.length) return res.status(404).json({ message: 'Единица измерения не найдена' })
    res.json(rows[0])
  } catch (err) {
    console.error('❌ Ошибка загрузки единицы измерения:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', requireMutationCapability('catalogs.edit'), async (req, res) => {
  try {
    const payload = await validatePayload(req.body || {})
    const [insert] = await db.execute(
      `
      INSERT INTO measurement_units
        (code, name_ru, name_en, symbol, dimension_type, base_unit_id, factor_to_base, is_active, is_system, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `,
      [
        payload.code,
        payload.name_ru,
        payload.name_en || null,
        payload.symbol || null,
        payload.dimension_type,
        payload.base_unit_id || null,
        payload.factor_to_base === undefined ? null : payload.factor_to_base,
        payload.is_active === undefined ? 1 : payload.is_active,
        payload.note || null,
      ]
    )
    const [rows] = await db.execute('SELECT * FROM measurement_units WHERE id = ?', [insert.insertId])
    res.status(201).json(rows[0])
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Единица с таким кодом уже существует' })
    }
    const code = err.status || 500
    if (code !== 500) return res.status(code).json({ message: err.message })
    console.error('❌ Ошибка создания единицы измерения:', err)
    res.status(500).json({ message: 'Ошибка сервера при создании единицы измерения' })
  }
})

router.put('/:id', requireMutationCapability('catalogs.edit'), async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [oldRows] = await db.execute('SELECT * FROM measurement_units WHERE id = ?', [id])
    if (!oldRows.length) return res.status(404).json({ message: 'Единица измерения не найдена' })
    const old = oldRows[0]

    const payload = await validatePayload(req.body || {}, { id, partial: true })
    if (old.is_system && payload.code && payload.code !== old.code) {
      return res.status(400).json({ message: 'Код системной единицы менять нельзя' })
    }

    const next = {
      code: payload.code ?? old.code,
      name_ru: payload.name_ru ?? old.name_ru,
      name_en: payload.name_en !== undefined ? payload.name_en : old.name_en,
      symbol: payload.symbol !== undefined ? payload.symbol : old.symbol,
      dimension_type: payload.dimension_type ?? old.dimension_type,
      base_unit_id: payload.base_unit_id !== undefined ? payload.base_unit_id : old.base_unit_id,
      factor_to_base: payload.factor_to_base !== undefined ? payload.factor_to_base : old.factor_to_base,
      is_active: payload.is_active !== undefined ? payload.is_active : old.is_active,
      note: payload.note !== undefined ? payload.note : old.note,
    }

    await db.execute(
      `
      UPDATE measurement_units
      SET code = ?, name_ru = ?, name_en = ?, symbol = ?, dimension_type = ?,
          base_unit_id = ?, factor_to_base = ?, is_active = ?, note = ?
      WHERE id = ?
      `,
      [
        next.code,
        next.name_ru,
        next.name_en,
        next.symbol,
        next.dimension_type,
        next.base_unit_id || null,
        next.factor_to_base,
        next.is_active,
        next.note,
        id,
      ]
    )
    const [rows] = await db.execute('SELECT * FROM measurement_units WHERE id = ?', [id])
    res.json(rows[0])
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Единица с таким кодом уже существует' })
    }
    const code = err.status || 500
    if (code !== 500) return res.status(code).json({ message: err.message })
    console.error('❌ Ошибка обновления единицы измерения:', err)
    res.status(500).json({ message: 'Ошибка сервера при обновлении единицы измерения' })
  }
})

router.delete('/:id', requireMutationCapability('catalogs.edit'), async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute('SELECT * FROM measurement_units WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ message: 'Единица измерения не найдена' })
    const unit = rows[0]
    const usage = await buildUsageSummary()
    const usageTotal = usage.byCode[String(unit.code || '').toLowerCase()]?.total || 0

    if (unit.is_system || usageTotal > 0) {
      await db.execute('UPDATE measurement_units SET is_active = 0 WHERE id = ?', [id])
      return res.json({ ok: true, deactivated: true, usage_total: usageTotal })
    }

    await db.execute('DELETE FROM measurement_units WHERE id = ?', [id])
    res.json({ ok: true, deleted: true })
  } catch (err) {
    console.error('❌ Ошибка удаления единицы измерения:', err)
    res.status(500).json({ message: 'Ошибка сервера при удалении единицы измерения' })
  }
})

module.exports = router
