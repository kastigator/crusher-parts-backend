const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const nz = (v) => (v === undefined || v === null ? '' : String(v).trim())
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const normCountry = (v) => {
  const s = nz(v).toUpperCase()
  return s ? s.slice(0, 2) : null
}
const normDate = (v) => {
  const s = nz(v)
  if (!s) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}
const toTiny = (v, fallback = 1) => {
  if (v === undefined || v === null || v === '') return fallback
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'да'].includes(s)) return 1
  if (['0', 'false', 'no', 'n', 'нет'].includes(s)) return 0
  return fallback
}

const RESTRICTION_LEVELS = new Set(['none', 'watch', 'restricted', 'blocked'])
const normRestriction = (v) => {
  const s = nz(v).toLowerCase()
  return RESTRICTION_LEVELS.has(s) ? s : 'none'
}

const parseRequiredDocs = (value) => {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'object') return JSON.stringify(value)
  const text = String(value).trim()
  if (!text) return null
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    // Поддержка простого текстового списка документов.
    return JSON.stringify([text])
  }
}

async function selectOne(id) {
  const [[row]] = await db.execute(
    `SELECT tor.*, t.code AS tnved_code, t.description AS tnved_description
       FROM tnved_origin_rules tor
       JOIN tnved_codes t ON t.id = tor.tnved_code_id
      WHERE tor.id = ?`,
    [id]
  )
  return row || null
}

router.get('/', async (req, res) => {
  try {
    const onlyActive = String(req.query.only_active || '').trim() === '1'
    const country = normCountry(req.query.country)
    const q = nz(req.query.q)

    const where = []
    const params = []

    if (onlyActive) where.push('tor.is_active = 1')
    if (country) {
      where.push('tor.origin_country = ?')
      params.push(country)
    }
    if (q) {
      where.push('(t.code LIKE ? OR t.description LIKE ? OR tor.restriction_note LIKE ?)')
      const like = `%${q}%`
      params.push(like, like, like)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const [rows] = await db.query(
      `SELECT tor.*, t.code AS tnved_code, t.description AS tnved_description
         FROM tnved_origin_rules tor
         JOIN tnved_codes t ON t.id = tor.tnved_code_id
         ${whereSql}
        ORDER BY tor.is_active DESC, t.code ASC, tor.origin_country ASC, tor.id DESC`,
      params
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /tnved-origin-rules error:', e)
    res.status(500).json({ message: 'Ошибка загрузки правил ТН ВЭД' })
  }
})

router.post('/', async (req, res) => {
  try {
    const tnvedCodeId = toId(req.body?.tnved_code_id)
    const originCountry = normCountry(req.body?.origin_country)

    if (!tnvedCodeId) return res.status(400).json({ message: 'Код ТН ВЭД обязателен' })
    if (!originCountry) return res.status(400).json({ message: 'Страна происхождения обязательна' })

    const [[tnved]] = await db.execute('SELECT id FROM tnved_codes WHERE id = ?', [tnvedCodeId])
    if (!tnved) return res.status(400).json({ message: 'Указанный код ТН ВЭД не найден' })

    const [ins] = await db.execute(
      `INSERT INTO tnved_origin_rules
        (tnved_code_id, origin_country, duty_rate, vat_rate, restriction_level, restriction_note, required_docs, effective_from, effective_to, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tnvedCodeId,
        originCountry,
        numOrNull(req.body?.duty_rate),
        numOrNull(req.body?.vat_rate),
        normRestriction(req.body?.restriction_level),
        nz(req.body?.restriction_note) || null,
        parseRequiredDocs(req.body?.required_docs),
        normDate(req.body?.effective_from),
        normDate(req.body?.effective_to),
        toTiny(req.body?.is_active, 1),
      ]
    )

    const created = await selectOne(ins.insertId)
    res.status(201).json(created)
  } catch (e) {
    console.error('POST /tnved-origin-rules error:', e)
    res.status(500).json({ message: 'Ошибка создания правила' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[existing]] = await db.execute('SELECT * FROM tnved_origin_rules WHERE id = ?', [id])
    if (!existing) return res.status(404).json({ message: 'Правило не найдено' })

    const tnvedCodeId = toId(req.body?.tnved_code_id ?? existing.tnved_code_id)
    const originCountry = normCountry(req.body?.origin_country ?? existing.origin_country)

    if (!tnvedCodeId) return res.status(400).json({ message: 'Код ТН ВЭД обязателен' })
    if (!originCountry) return res.status(400).json({ message: 'Страна происхождения обязательна' })

    const [[tnved]] = await db.execute('SELECT id FROM tnved_codes WHERE id = ?', [tnvedCodeId])
    if (!tnved) return res.status(400).json({ message: 'Указанный код ТН ВЭД не найден' })

    await db.execute(
      `UPDATE tnved_origin_rules
          SET tnved_code_id = ?,
              origin_country = ?,
              duty_rate = ?,
              vat_rate = ?,
              restriction_level = ?,
              restriction_note = ?,
              required_docs = ?,
              effective_from = ?,
              effective_to = ?,
              is_active = ?
        WHERE id = ?`,
      [
        tnvedCodeId,
        originCountry,
        numOrNull(req.body?.duty_rate ?? existing.duty_rate),
        numOrNull(req.body?.vat_rate ?? existing.vat_rate),
        normRestriction(req.body?.restriction_level ?? existing.restriction_level),
        nz(req.body?.restriction_note ?? existing.restriction_note) || null,
        parseRequiredDocs(
          req.body?.required_docs !== undefined ? req.body?.required_docs : existing.required_docs
        ),
        normDate(req.body?.effective_from ?? existing.effective_from),
        normDate(req.body?.effective_to ?? existing.effective_to),
        toTiny(req.body?.is_active ?? existing.is_active, Number(existing.is_active) ? 1 : 0),
        id,
      ]
    )

    const updated = await selectOne(id)
    res.json(updated)
  } catch (e) {
    console.error('PUT /tnved-origin-rules/:id error:', e)
    res.status(500).json({ message: 'Ошибка обновления правила' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [result] = await db.execute('DELETE FROM tnved_origin_rules WHERE id = ?', [id])
    if (!result.affectedRows) return res.status(404).json({ message: 'Правило не найдено' })

    res.status(204).send()
  } catch (e) {
    console.error('DELETE /tnved-origin-rules/:id error:', e)
    res.status(500).json({ message: 'Ошибка удаления правила' })
  }
})

module.exports = router
