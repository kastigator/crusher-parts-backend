const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// helpers
const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) => (typeof v === 'string' ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null)
const bool01 = (v, def = 0) =>
  v === true || v === 1 || v === '1' || v === 'true'
    ? 1
    : v === false || v === 0 || v === '0' || v === 'false'
    ? 0
    : def

// LIST (с простыми фильтрами)
router.get('/', async (req, res) => {
  try {
    const { q, active } = req.query
    const params = []
    let sql = 'SELECT * FROM part_suppliers'
    const where = []

    if (q && q.trim()) {
      where.push('(name LIKE ? OR supplier_code LIKE ? OR vat_number LIKE ?)')
      params.push(`%${q.trim()}%`, `%${q.trim()}%`, `%${q.trim()}%`)
    }
    if (active === '0' || active === '1') {
      where.push('active = ?')
      params.push(Number(active))
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

// GET ONE
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

// CREATE
router.post('/', auth, async (req, res) => {
  let {
    supplier_code, external_id,
    name, vat_number, country, website, contact_person, email, phone,
    address, payment_terms, preferred_currency, incoterms, default_lead_time_days,
    is_oem, quality_certified, active, notes
  } = req.body

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Поле name обязательно' })
  }

  default_lead_time_days = nz(default_lead_time_days) !== null ? Number(default_lead_time_days) : null
  is_oem = bool01(is_oem, 0)
  quality_certified = bool01(quality_certified, 0)
  active = bool01(active, 1)

  country = nz(country) ? up(country, 2) : null
  preferred_currency = nz(preferred_currency) ? up(preferred_currency, 3) : null
  incoterms = nz(incoterms) ? up(incoterms) : null
  supplier_code = nz(supplier_code)

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO part_suppliers
       (supplier_code, external_id, name, vat_number, country, website, contact_person, email, phone, address,
        payment_terms, preferred_currency, incoterms, default_lead_time_days, is_oem, quality_certified, active, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        supplier_code, nz(external_id), name.trim(), nz(vat_number), country, nz(website),
        nz(contact_person), nz(email), nz(phone), nz(address),
        nz(payment_terms), preferred_currency, incoterms, default_lead_time_days,
        is_oem, quality_certified, active, nz(notes)
      ]
    )

    const id = ins.insertId
    // автоген supplier_code если не пришел
    if (!supplier_code) {
      const gen = `SUP-${String(id).padStart(6, '0')}`
      await conn.execute('UPDATE part_suppliers SET supplier_code=? WHERE id=?', [gen, id])
    }

    await logActivity({ req, action: 'create', entity_type: 'part_suppliers', entity_id: id, comment: 'Создан поставщик' })
    await conn.commit()

    const [fresh] = await db.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
    res.status(201).json(fresh[0])
  } catch (e) {
    await conn.rollback()
    console.error('POST /part-suppliers error', e)
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Запись с таким supplier_code или vat_number уже существует' })
    }
    res.status(500).json({ message: 'Ошибка сервера при добавлении поставщика' })
  } finally {
    conn.release()
  }
})

// UPDATE (optimistic by updated_at + detailed diffs)
router.put('/:id', auth, async (req, res) => {
  const {
    updated_at, // обязателен для конфликтов
  } = req.body
  if (!updated_at) return res.status(400).json({ message: 'Отсутствует updated_at для проверки конфликтов' })

  // нормализация входа
  const body = { ...req.body }
  if (body.country !== undefined) body.country = nz(body.country) ? up(body.country, 2) : null
  if (body.preferred_currency !== undefined) body.preferred_currency = nz(body.preferred_currency) ? up(body.preferred_currency, 3) : null
  if (body.incoterms !== undefined) body.incoterms = nz(body.incoterms) ? up(body.incoterms) : null
  if (body.default_lead_time_days !== undefined)
    body.default_lead_time_days = body.default_lead_time_days === '' || body.default_lead_time_days === null ? null : Number(body.default_lead_time_days)
  if (body.is_oem !== undefined) body.is_oem = bool01(body.is_oem, 0)
  if (body.quality_certified !== undefined) body.quality_certified = bool01(body.quality_certified, 0)
  if (body.active !== undefined) body.active = bool01(body.active, 1)

  // собираем SET
  const allowed = [
    'supplier_code','external_id','name','vat_number','country','website','contact_person','email','phone','address',
    'payment_terms','preferred_currency','incoterms','default_lead_time_days','is_oem','quality_certified','active','notes'
  ]
  const set = []
  const vals = []
  for (const f of allowed) {
    if (body[f] !== undefined) {
      set.push(`\`${f}\`=?`)
      vals.push(nz(body[f]))
    }
  }
  if (!set.length) return res.json({ message: 'Нет изменений' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [req.params.id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден' })
    }
    const oldData = oldRows[0]

    const [upd] = await conn.execute(
      `UPDATE part_suppliers SET ${set.join(', ')} WHERE id=? AND updated_at=?`,
      [...vals, req.params.id, updated_at]
    )
    if (!upd.affectedRows) {
      await conn.rollback()
      return res.status(409).json({ message: 'Появились новые изменения. Обновите данные и повторите.' })
    }

    const [fresh] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [req.params.id])

    // подробные диффы
    await logFieldDiffs({
      req,
      oldData,
      newData: fresh[0],
      entity_type: 'part_suppliers',
      entity_id: Number(req.params.id)
    })

    await conn.commit()
    res.json(fresh[0])
  } catch (e) {
    await conn.rollback()
    console.error('PUT /part-suppliers/:id error', e)
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Конфликт уникальности (supplier_code или vat_number)' })
    }
    res.status(500).json({ message: 'Ошибка сервера при обновлении поставщика' })
  } finally {
    conn.release()
  }
})

// DELETE
router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()
    const [old] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [req.params.id])
    if (!old.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден' })
    }

    await conn.execute('DELETE FROM part_suppliers WHERE id=?', [req.params.id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'part_suppliers',
      entity_id: Number(req.params.id),
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
