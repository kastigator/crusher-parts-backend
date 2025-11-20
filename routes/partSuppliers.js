// routes/partSuppliers.js
const express = require('express')
const db = require('../utils/db')
const router = express.Router()

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')
const checkTabAccess = require('../middleware/requireTabAccess')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// вкладка Поставщики
const TAB_PATH = '/suppliers'

// helpers
const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) =>
  v == null
    ? null
    : typeof v === 'string'
    ? v.trim().toUpperCase().slice(0, n || v.length)
    : v
const toInt = (v) => (v === '' || v == null ? null : Number(v))

// утилита для разбора конфликтов уникальности
const handleDuplicateError = (e, res) => {
  if (e && e.code === 'ER_DUP_ENTRY') {
    const msg = e.sqlMessage || e.message || ''
    let field = 'unknown'
    if (msg.includes('uniq_part_suppliers_vat')) field = 'vat_number'
    else if (msg.includes('uniq_part_suppliers_public_code')) field = 'public_code'

    let type = 'duplicate_key'
    let message = 'Конфликт уникальности'

    if (field === 'vat_number') {
      type = 'duplicate_vat'
      message = 'Поставщик с таким VAT уже существует'
    } else if (field === 'public_code') {
      type = 'duplicate_public_code'
      message = 'Поставщик с таким публичным кодом уже существует'
    }

    return res.status(409).json({ type, field, message })
  }
  return null
}

/* =========================================================
   ЛОГИ ПО ПОСТАВЩИКАМ (агрегированные) — ВАЖНО: до "/:id"
   ========================================================= */

// Все логи данного поставщика (история)
// ⛔ только для admin (или кого захочешь в будущем)
router.get('/:id/logs/combined', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
  try {
    const [logs] = await db.execute(
      `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'suppliers' AND a.entity_id = ?
      ORDER BY a.created_at DESC
    `,
      [id]
    )
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/:id/logs/combined error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении логов' })
  }
})

// Удалённые логи по всем поставщикам
router.get('/logs/deleted', auth, adminOnly, async (_req, res) => {
  try {
    const [logs] = await db.execute(
      `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete' AND a.entity_type = 'suppliers'
      ORDER BY a.created_at DESC
    `
    )
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/logs/deleted error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

// Удалённые логи по конкретному поставщику
router.get('/:id/logs/deleted', auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
  try {
    const [logs] = await db.execute(
      `
      SELECT a.*, u.full_name AS user_name
      FROM activity_logs a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action = 'delete'
        AND a.entity_type = 'suppliers'
        AND a.entity_id = ?
      ORDER BY a.created_at DESC
    `,
      [id]
    )
    res.json(logs)
  } catch (e) {
    console.error('GET /part-suppliers/:id/logs/deleted error', e)
    res.status(500).json({ message: 'Ошибка сервера при получении удалённых логов' })
  }
})

// Универсальный маркер изменений (COUNT:SUM(version))
router.get('/etag', auth, checkTabAccess(TAB_PATH), async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS cnt, COALESCE(SUM(version), 0) AS sum_ver
       FROM part_suppliers`
    )
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error('GET /part-suppliers/etag error', e)
    res.status(500).json({ message: 'Server error' })
  }
})

/* ======================
   LIST
   ====================== */
router.get('/', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  try {
    const { q } = req.query
    const params = []
    let sql = 'SELECT * FROM part_suppliers'
    const where = []

    if (q && q.trim()) {
      const like = `%${q.trim()}%`
      where.push(
        '(name LIKE ? OR vat_number LIKE ? OR email LIKE ? OR phone LIKE ? OR public_code LIKE ?)'
      )
      params.push(like, like, like, like, like)
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
router.get('/:id', auth, checkTabAccess(TAB_PATH), async (req, res) => {
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
router.post('/', auth, checkTabAccess(TAB_PATH), async (req, res) => {
  let {
    name,
    vat_number,
    country,
    website,
    contact_person,
    email,
    phone,
    payment_terms,
    preferred_currency,
    incoterms,
    default_lead_time_days,
    notes,
    public_code
  } = req.body || {}

  if (!name || !name.trim()) {
    return res.status(400).json({ message: 'Поле name обязательно' })
  }

  public_code = nz(public_code) ? up(public_code, 32) : null
  if (!public_code) {
    return res.status(400).json({ message: 'Публичный код поставщика (public_code) обязателен' })
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
        payment_terms, preferred_currency, incoterms, default_lead_time_days, notes, public_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        nz(notes),
        public_code
      ]
    )

    const id = ins.insertId
    const [fresh] = await conn.execute('SELECT * FROM part_suppliers WHERE id=?', [id])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: id,
      comment: 'Создан поставщик'
    })

    await conn.commit()
    res.status(201).json(fresh[0])
  } catch (e) {
    await conn.rollback()
    console.error('POST /part-suppliers error', e)
    if (handleDuplicateError(e, res)) return
    res.status(500).json({ message: 'Ошибка сервера при добавлении поставщика' })
  } finally {
    conn.release()
  }
})

/* ======================
   UPDATE (optimistic by version)
   ====================== */
router.put('/:id', auth, checkTabAccess(TAB_PATH), async (req, res) => {
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

  if (body.public_code !== undefined) {
    body.public_code = nz(body.public_code) ? up(body.public_code, 32) : null
  }

  const allowed = [
    'name',
    'vat_number',
    'country',
    'website',
    'contact_person',
    'email',
    'phone',
    'payment_terms',
    'preferred_currency',
    'incoterms',
    'default_lead_time_days',
    'notes',
    'public_code'
  ]

  const set = []
  const vals = []

  for (const f of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      if (f === 'name') {
        const nm = (body.name || '').trim()
        if (!nm) return res.status(400).json({ message: 'Поле name не может быть пустым' })
        set.push('`name`=?')
        vals.push(nm)
      } else if (f === 'public_code') {
        const code = body.public_code
        if (!code) {
          return res
            .status(400)
            .json({ message: 'Публичный код поставщика (public_code) не может быть пустым' })
        }
        set.push('`public_code`=?')
        vals.push(code)
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
    if (handleDuplicateError(e, res)) return
    res.status(500).json({ message: 'Ошибка сервера при обновлении поставщика' })
  } finally {
    conn.release()
  }
})

/* ======================
   DELETE (optional version check via ?version=)
   ====================== */
router.delete('/:id', auth, checkTabAccess(TAB_PATH), async (req, res) => {
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

    // FK ON DELETE CASCADE удалит дочерние записи
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
