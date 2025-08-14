const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// helpers
const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) =>
  typeof v === 'string' ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null

/* ======================
   LIST
   ====================== */
router.get('/', async (req, res) => {
  try {
    const { q } = req.query
    const params = []
    let sql = 'SELECT * FROM part_suppliers'
    const where = []

    if (q && q.trim()) {
      const like = `%${q.trim()}%`
      where.push('(name LIKE ? OR vat_number LIKE ? OR email LIKE ? OR phone LIKE ?)')
      params.push(like, like, like, like)
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY name ASC'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (e) {
    console.error('GET /part-suppliers error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении поставщиков' })
  }
})

/* ======================
   GET ONE
   ====================== */
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM part_suppliers WHERE id=?', [req.params.id])
    if (!rows.length) return res.status(404).json({ message: 'Поставщик не найден' })
    res.json(rows[0])
  } catch (e) {
    console.error('GET /part-suppliers/:id error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении поставщика' })
  }
})

/* ======================
   CREATE
   ====================== */
router.post('/', auth, async (req, res) => {
  let {
    name,
    vat_number,
    country,
    website,
    contact_person,
    email,
    phone,
    // address — удалено из схемы
    payment_terms,
    preferred_currency,
    incoterms,
    default_lead_time_days,
    notes
  } = req.body

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Поле name обязательно' })
  }

  default_lead_time_days = nz(default_lead_time_days) !== null ? Number(default_lead_time_days) : null
  country = nz(country) ? up(country, 2) : null
  preferred_currency = nz(preferred_currency) ? up(preferred_currency, 3) : null
  incoterms = nz(incoterms) ? up(incoterms) : null

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO part_suppliers
       (name, vat_number, country, website, contact_person, email, phone,
        payment_terms, preferred_currency, incoterms, default_lead_time_days, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name.trim(),
        nz(vat_number),
        country,
        nz(website),
        nz(contact_person),
        nz(email),
        nz(phone),
        nz(payment_terms),
        preferred_currency,
        incoterms,
        default_lead_time_days,
        nz(notes)
      ]
    )

    const id = ins.insertId
    const [fresh] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: id,
      comment: 'Создан поставщик',
      diff: fresh[0]
    })

    await conn.commit()
    res.status(201).json(fresh[0])
  } catch (e) {
    await conn.rollback()
    console.error('POST /part-suppliers error', e)
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Поставщик с таким VAT уже существует' })
    }
    res.status(500).json({ message: 'Ошибка сервера при добавлении поставщика' })
  } finally {
    conn.release()
  }
})

/* ======================
   UPDATE (optimistic by version)
   ====================== */
router.put('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  const { version } = req.body || {}

  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Некорректный id' })
  }
  if (version == null) {
    return res.status(400).json({ message: 'Отсутствует version для проверки конфликтов' })
  }

  const body = { ...req.body }

  if (body.country !== undefined) body.country = nz(body.country) ? up(body.country, 2) : null
  if (body.preferred_currency !== undefined)
    body.preferred_currency = nz(body.preferred_currency) ? up(body.preferred_currency, 3) : null
  if (body.incoterms !== undefined)
    body.incoterms = nz(body.incoterms) ? up(body.incoterms) : null
  if (body.default_lead_time_days !== undefined)
    body.default_lead_time_days =
      body.default_lead_time_days === '' || body.default_lead_time_days === null
        ? null
        : Number(body.default_lead_time_days)

  const allowed = [
    'name',
    'vat_number',
    'country',
    'website',
    'contact_person',
    'email',
    'phone',
    // 'address' — удалено
    'payment_terms',
    'preferred_currency',
    'incoterms',
    'default_lead_time_days',
    'notes'
  ]

  const set = []
  const vals = []

  for (const f of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      set.push(`\`${f}\`=?`)
      vals.push(nz(body[f]))
    }
  }

  // если нет пользовательских полей — нет изменений
  if (!set.length) return res.json({ message: 'Нет изменений' })

  // техническое: инкрементим версию и updated_at
  set.push('version = version + 1')
  set.push('updated_at = NOW()')

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден' })
    }
    const oldData = oldRows[0]

    // optimistic by version
    const [upd] = await conn.execute(
      `UPDATE part_suppliers SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, version]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
      return res
        .status(409)
        .json({ message: 'Появились новые изменения. Обновите данные и повторите.', current: currentRows[0] })
    }

    const [fresh] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])

    await logFieldDiffs({
      req,
      oldData,
      newData: fresh[0],
      entity_type: 'suppliers',
      entity_id: id
    })

    await conn.commit()
    res.json(fresh[0])
  } catch (e) {
    await conn.rollback()
    console.error('PUT /part-suppliers/:id error', e)
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Конфликт уникальности (vat_number)' })
    }
    res.status(500).json({ message: 'Ошибка сервера при обновлении поставщика' })
  } finally {
    conn.release()
  }
})

/* ======================
   DELETE
   ====================== */
router.delete('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Некорректный id' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [old] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
    if (!old.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден' })
    }

    await conn.execute('DELETE FROM part_suppliers WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: id,
      comment: 'Удалено пользователем'
    })

    await conn.commit()
    res.json({ message: 'Поставщик удалён' })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /part-suppliers/:id error', e)
    res.status(500).json({ message: 'Ошибка сервера при удалении поставщика' })
  } finally {
    conn.release()
  }
})

module.exports = router
