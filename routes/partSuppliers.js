// routes/partSuppliers.js
const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// helpers
const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) =>
  v == null
    ? null
    : typeof v === 'string'
    ? v.trim().toUpperCase().slice(0, n || v.length)
    : v
const toInt = (v) => (v === '' || v == null ? null : Number(v))

/* =========================================================
   ЛОГИ ПО ПОСТАВЩИКАМ (агрегированные)
   ========================================================= */

// ВАЖНО: эти маршруты должны идти ПЕРЕД "/:id", чтобы
// "logs/combined" и "logs/deleted" не попали в :id.

// Все логи данного поставщика (entity_type = 'suppliers')
router.get('/:id/logs/combined', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
  try {
    const [logs] = await db.execute(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'suppliers' AND a.entity_id = ?
      ORDER BY a.created_at DESC
    `, [id])
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/:id/logs/combined error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении логов' })
  }
})

// Удалённые логи по всем поставщикам
router.get('/logs/deleted', auth, async (_req, res) => {
  try {
    const [logs] = await db.execute(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete' AND a.entity_type = 'suppliers'
      ORDER BY a.created_at DESC
    `)
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/logs/deleted error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

// Удалённые логи по конкретному поставщику
router.get('/:id/logs/deleted', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
  try {
    const [logs] = await db.execute(`
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete'
        AND a.entity_type = 'suppliers'
        AND a.entity_id = ?
      ORDER BY a.created_at DESC
    `, [id])
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/:id/logs/deleted error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

/* ======================
   LIST
   ====================== */
router.get('/', auth, async (req, res) => {
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
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })

    const [rows] = await db.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
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
  } = req.body || {}

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Поле name обязательно' })
  }

  default_lead_time_days = toInt(default_lead_time_days)
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
      entity_type: 'suppliers', // для фронта/истории
      entity_id: id,
      comment: 'Создан поставщик'
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

  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }
  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Отсутствует или некорректен version' })
  }

  const body = { ...req.body }

  if (body.country !== undefined) body.country = nz(body.country) ? up(body.country, 2) : null
  if (body.preferred_currency !== undefined)
    body.preferred_currency = nz(body.preferred_currency) ? up(body.preferred_currency, 3) : null
  if (body.incoterms !== undefined) body.incoterms = nz(body.incoterms) ? up(body.incoterms) : null
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
      // не позволяем сделать name пустым/NULL, если поле прислано
      if (f === 'name') {
        const nm = (body.name || '').trim()
        if (!nm) return res.status(400).json({ message: 'Поле name не может быть пустым' })
        set.push('`name`=?')
        vals.push(nm)
      } else {
        set.push(`\`${f}\`=?`)
        vals.push(nz(body[f]))
      }
    }
  }

  if (!set.length) {
    return res.json({ message: 'Нет изменений' })
  }

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

    const [upd] = await conn.execute(
      `UPDATE part_suppliers SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, Number(version)]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Появились новые изменения. Обновите данные и повторите.',
        current: currentRows[0] || null
      })
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
   DELETE (optional version check via ?version=)
   ====================== */
router.delete('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }
  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'version must be numeric' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Поставщик не найден' })
    }
    const old = oldRows[0]

    if (version !== undefined && version !== old.version) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Запись была изменена и не может быть удалена без обновления',
        current: old
      })
    }

    // при наличии FK ON DELETE CASCADE дочерние удалятся автоматически
    await conn.execute('DELETE FROM part_suppliers WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: id,
      comment: `Поставщик "${old.name}" удалён`
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
