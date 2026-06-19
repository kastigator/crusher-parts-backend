const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const parseAliases = (value) => {
  if (Array.isArray(value)) return value.map(nz).filter(Boolean)
  const raw = nz(value)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(nz).filter(Boolean)
  } catch (_) {
    // Fall through to comma parsing.
  }
  return raw.split(',').map(nz).filter(Boolean)
}

const serializeAliases = (value) => JSON.stringify(parseAliases(value))

const rowToDto = (row) => ({
  ...row,
  aliases: parseAliases(row.aliases_json),
})

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const params = []
    const where = ['is_active = 1']

    if (q) {
      where.push('(term LIKE ? OR aliases_json LIKE ? OR definition LIKE ? OR canonical_entity LIKE ? OR scope LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }

    const [rows] = await db.execute(
      `
      SELECT *
      FROM classifier_glossary_terms
      WHERE ${where.join(' AND ')}
      ORDER BY term
      LIMIT 300
      `,
      params
    )
    res.json(rows.map(rowToDto))
  } catch (err) {
    console.error('GET /glossary-terms error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const term = nz(req.body.term)
    const definition = nz(req.body.definition)
    if (!term || !definition) {
      return res.status(400).json({ message: 'Заполните термин и определение' })
    }

    const [result] = await db.execute(
      `
      INSERT INTO classifier_glossary_terms
        (term, aliases_json, definition, canonical_entity, scope, notes, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      `,
      [
        term,
        serializeAliases(req.body.aliases),
        definition,
        nz(req.body.canonical_entity),
        nz(req.body.scope),
        nz(req.body.notes),
      ]
    )
    const [[row]] = await db.execute('SELECT * FROM classifier_glossary_terms WHERE id = ?', [result.insertId])
    res.status(201).json(rowToDto(row))
  } catch (err) {
    console.error('POST /glossary-terms error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const term = nz(req.body.term)
    const definition = nz(req.body.definition)
    if (!term || !definition) {
      return res.status(400).json({ message: 'Заполните термин и определение' })
    }

    await db.execute(
      `
      UPDATE classifier_glossary_terms
      SET term = ?,
          aliases_json = ?,
          definition = ?,
          canonical_entity = ?,
          scope = ?,
          notes = ?,
          is_active = ?
      WHERE id = ?
      `,
      [
        term,
        serializeAliases(req.body.aliases),
        definition,
        nz(req.body.canonical_entity),
        nz(req.body.scope),
        nz(req.body.notes),
        req.body.is_active === false ? 0 : 1,
        id,
      ]
    )
    const [[row]] = await db.execute('SELECT * FROM classifier_glossary_terms WHERE id = ?', [id])
    if (!row) return res.status(404).json({ message: 'Термин не найден' })
    res.json(rowToDto(row))
  } catch (err) {
    console.error('PUT /glossary-terms/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })
    await db.execute('UPDATE classifier_glossary_terms SET is_active = 0 WHERE id = ?', [id])
    res.json({ ok: true })
  } catch (err) {
    console.error('DELETE /glossary-terms/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
