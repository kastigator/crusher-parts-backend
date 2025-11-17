// routes/supplierAddresses.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

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
// не возвращаем NaN — только число или null
const num = (v) => {
  if (v === '' || v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/* ======================
   ETAG (для баннера изменений)
   ====================== */
// ВАЖНО: этот маршрут должен быть ДО '/:id'
router.get('/etag', async (req, res) => {
  try {
    const supplierId =
      req.query.supplier_id !== undefined ? Number(req.query.supplier_id) : null
    if (supplierId !== null && !Number.isFinite(supplierId)) {
      return res.status(400).json({ message: 'supplier_id must be numeric' })
    }

    const baseSql = `SELECT COUNT(*) AS cnt, COALESCE(SUM(version),0) AS sum_ver FROM supplier_addresses`
    const sql = supplierId === null ? baseSql : `${baseSql} WHERE supplier_id=?`
    const params = supplierId === null ? [] : [supplierId]

    const [rows] = await db.execute(sql, params)
    const { cnt, sum_ver } = rows[0] || { cnt: 0, sum_ver: 0 }
    return res.json({ etag: `${cnt}:${sum_ver}`, cnt, sum_ver })
  } catch (e) {
    console.error('GET /supplier-addresses/etag error', e)
    return res.status(500).json({ message: 'Ошибка получения etag' })
  }
})

/* ======================
   LIST
   ====================== */
router.get('/', async (req, res) => {
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
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'id must be numeric' })
    }

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
router.post('/', async (req, res) => {
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
    comment,
  } = req.body || {}

  const sid = Number(supplier_id)
  if (!Number.isFinite(sid)) {
    return res.status(400).json({ message: 'supplier_id must be numeric' })
  }
  if (!formatted_address?.trim()) {
    return res
      .status(400)
      .json({ message: "Поле 'formatted_address' обязательно" })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    try {
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
          nz(comment),
        ]
      )

      const [rows] = await conn.execute(
        'SELECT * FROM supplier_addresses WHERE id=?',
        [ins.insertId]
      )

      await logActivity({
        req,
        action: 'create',
        entity_type: 'suppliers', // агрегируем логи на карточке поставщика
        entity_id: sid,
        comment: 'Добавлен адрес поставщика',
      })

      await conn.commit()
      return res.status(201).json(rows[0])
    } catch (e) {
      await conn.rollback()
      // FK-ошибка (нет такого supplier_id)
      if (e && e.errno === 1452) {
        return res.status(409).json({
          type: 'fk_constraint',
          message:
            'Поставщик не найден или нарушена ссылочная целостность (supplier_id).',
        })
      }
      console.error('POST /supplier-addresses error', e)
      return res.status(500).json({ message: 'Ошибка добавления адреса' })
    }
  } catch (e) {
    console.error('POST /supplier-addresses transaction error', e)
    return res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

/* ======================
   UPDATE
   ====================== */
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }

  const {
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
    comment,
    version,
  } = req.body || {}

  if (!formatted_address?.trim()) {
    return res
      .status(400)
      .json({ message: "Поле 'formatted_address' обязательно" })
  }

  const ver = Number(version)
  if (!Number.isFinite(ver)) {
    return res.status(400).json({ message: 'version must be numeric' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.execute(
      'SELECT * FROM supplier_addresses WHERE id=? FOR UPDATE',
      [id]
    )
    if (!rows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Адрес не найден' })
    }

    const current = rows[0]
    if (current.version !== ver) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Версия записи изменилась',
        currentRecord: current,
      })
    }

    await conn.execute(
      `UPDATE supplier_addresses
         SET label=?,
             type=?,
             formatted_address=?,
             city=?,
             street=?,
             house=?,
             building=?,
             entrance=?,
             region=?,
             country=?,
             is_precise_location=?,
             place_id=?,
             lat=?,
             lng=?,
             postal_code=?,
             comment=?,
             version = version + 1,
             updated_at = NOW()
       WHERE id=?`,
      [
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
        nz(comment),
        id,
      ]
    )

    const [freshRows] = await conn.execute(
      'SELECT * FROM supplier_addresses WHERE id=?',
      [id]
    )
    const fresh = freshRows[0]

    await logFieldDiffs({
      req,
      oldData: current,
      newData: fresh,
      entity_type: 'suppliers',
      entity_id: Number(fresh.supplier_id),
      // можно добавить exclude при необходимости
      // exclude: ['id', 'created_at', 'updated_at', 'version']
    })

    await conn.commit()
    res.json(fresh)
  } catch (e) {
    await conn.rollback()
    console.error('PUT /supplier-addresses/:id error', e)
    res.status(500).json({ message: 'Ошибка обновления адреса' })
  } finally {
    conn.release()
  }
})

/* ======================
   DELETE
   ====================== */
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) {
    return res.status(400).json({ message: 'id must be numeric' })
  }

  const version = req.query.version !== undefined ? Number(req.query.version) : null

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.execute(
      'SELECT * FROM supplier_addresses WHERE id=? FOR UPDATE',
      [id]
    )
    if (!rows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Адрес не найден' })
    }

    const current = rows[0]
    if (version !== null && Number.isFinite(version) && current.version !== version) {
      await conn.rollback()
      return res.status(409).json({
        type: 'version_conflict',
        message: 'Версия записи изменилась',
        currentRecord: current,
      })
    }

    await conn.execute('DELETE FROM supplier_addresses WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: current.supplier_id,
      comment: 'Удалён адрес поставщика',
    })

    await conn.commit()
    res.json({ success: true })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /supplier-addresses/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления адреса' })
  } finally {
    conn.release()
  }
})

module.exports = router
