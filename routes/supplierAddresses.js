// routes/supplierAddresses.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

// helpers
const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) =>
  v == null ? null : typeof v === 'string' ? v.trim().toUpperCase().slice(0, n || v.length) : v
const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v))

/* ======================
   LIST
   ====================== */
router.get('/', auth, async (req, res) => {
  try {
    const { supplier_id } = req.query
    const params = []
    let sql = 'SELECT * FROM supplier_addresses'
    if (supplier_id !== undefined) {
      const sid = Number(supplier_id)
      if (!Number.isFinite(sid)) {
        return res.status(400).json({ message: 'supplier_id must be numeric' })
      }
      sql += ' WHERE supplier_id=?'
      params.push(sid)
    }
    sql += ' ORDER BY created_at DESC, id DESC'
    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (e) {
    console.error('GET /supplier-addresses error', e)
    res.status(500).json({ message: 'Ошибка получения адресов' })
  }
})

/* ======================
   GET ONE
   ====================== */
router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
    const [rows] = await db.execute('SELECT * FROM supplier_addresses WHERE id=?', [id])
    if (!rows.length) return res.status(404).json({ message: 'Адрес не найден' })
    res.json(rows[0])
  } catch (e) {
    console.error('GET /supplier-addresses/:id error', e)
    res.status(500).json({ message: 'Ошибка получения адреса' })
  }
})

/* ======================
   CREATE
   ====================== */
router.post('/', auth, async (req, res) => {
  const {
    supplier_id,
    label,
    type,
    formatted_address,
    city,
    street,
    house,
    building,
    entrance,
    region,
    country,
    is_precise_location,
    place_id,
    lat,
    lng,
    postal_code,
    comment
    // is_primary — удалено
  } = req.body || {}

  const sid = Number(supplier_id)
  if (!Number.isFinite(sid)) return res.status(400).json({ message: 'supplier_id must be numeric' })
  if (!formatted_address?.trim()) {
    return res.status(400).json({ message: "Поле 'formatted_address' обязательно" })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO supplier_addresses
         (supplier_id,label,type,formatted_address,city,street,house,building,entrance,region,country,
          is_precise_location,place_id,lat,lng,postal_code,comment)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        sid,
        nz(label),
        nz(type),
        formatted_address.trim(),
        nz(city),
        nz(street),
        nz(house),
        nz(building),
        nz(entrance),
        nz(region),
        nz(up(country, 2)),
        is_precise_location ? 1 : 0,
        nz(place_id),
        num(lat),
        num(lng),
        nz(postal_code),
        nz(comment)
      ]
    )

    const [row] = await conn.execute('SELECT * FROM supplier_addresses WHERE id=?', [ins.insertId])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers', // агрегируем логи по поставщику
      entity_id: sid,
      comment: 'Добавлен адрес поставщика'
    })

    await conn.commit()
    res.status(201).json(row[0])
  } catch (e) {
    await conn.rollback()
    console.error('POST /supplier-addresses error', e)
    res.status(500).json({ message: 'Ошибка добавления адреса' })
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
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ message: 'Отсутствует или некорректен version' })
  }

  // список редактируемых полей (без is_primary)
  const fields = [
    'label',
    'type',
    'formatted_address',
    'city',
    'street',
    'house',
    'building',
    'entrance',
    'region',
    'country',
    'is_precise_location',
    'place_id',
    'lat',
    'lng',
    'postal_code',
    'comment'
  ]

  // нормализация входа
  const body = { ...req.body }
  if (Object.prototype.hasOwnProperty.call(body, 'country')) body.country = nz(up(body.country, 2))
  if (Object.prototype.hasOwnProperty.call(body, 'lat')) body.lat = num(body.lat)
  if (Object.prototype.hasOwnProperty.call(body, 'lng')) body.lng = num(body.lng)
  if (Object.prototype.hasOwnProperty.call(body, 'is_precise_location'))
    body.is_precise_location = body.is_precise_location ? 1 : 0
  // is_primary — удалено

  const set = []
  const vals = []
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      set.push(`\`${f}\`=?`)
      vals.push(f === 'formatted_address' && typeof body[f] === 'string' ? body[f].trim() : nz(body[f]))
    }
  }

  if (!set.length) return res.json({ message: 'Нет изменений' })

  // техполя
  set.push('version = version + 1')
  set.push('updated_at = NOW()')

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM supplier_addresses WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Адрес не найден' })
    }
    const oldData = oldRows[0]

    const [upd] = await conn.execute(
      `UPDATE supplier_addresses SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, Number(version)]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM supplier_addresses WHERE id=?', [id])
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Появились новые изменения. Обновите данные.',
        current: currentRows[0] || null
      })
    }

    const [fresh] = await conn.execute('SELECT * FROM supplier_addresses WHERE id=?', [id])

    await logFieldDiffs({
      req,
      oldData,
      newData: fresh[0],
      entity_type: 'suppliers',
      entity_id: Number(fresh[0].supplier_id)
    })

    await conn.commit()
    res.json(fresh[0])
  } catch (e) {
    await conn.rollback()
    console.error('PUT /supplier-addresses/:id error', e)
    res.status(500).json({ message: 'Ошибка обновления адреса' })
  } finally {
    conn.release()
  }
})

/* ======================
   DELETE (optional version check via ?version=)
   ====================== */
router.delete('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'id must be numeric' })
  const versionParam = req.query.version
  const version = versionParam !== undefined ? Number(versionParam) : undefined
  if (versionParam !== undefined && !Number.isFinite(version)) {
    return res.status(400).json({ message: 'version must be numeric' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM supplier_addresses WHERE id=?', [id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Адрес не найден' })
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

    await conn.execute('DELETE FROM supplier_addresses WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: Number(old.supplier_id),
      comment: 'Удалён адрес поставщика'
    })

    await conn.commit()
    res.json({ message: 'Адрес удалён' })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /supplier-addresses/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления адреса' })
  } finally {
    conn.release()
  }
})

module.exports = router
