const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => (v === '' || v === undefined ? null : v)
const up = (v, n) =>
  typeof v === 'string' ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null
const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v))

/* ======================
   LIST
   ====================== */
router.get('/', async (req, res) => {
  try {
    const { supplier_id } = req.query
    const params = []
    let sql = 'SELECT * FROM supplier_addresses'
    if (supplier_id) { sql += ' WHERE supplier_id=?'; params.push(Number(supplier_id)) }
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
    const [rows] = await db.execute('SELECT * FROM supplier_addresses WHERE id=?', [req.params.id])
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
    supplier_id, label, type, formatted_address, city, street, house, building, entrance,
    region, country, is_precise_location, place_id, lat, lng, postal_code, comment, is_primary
  } = req.body

  if (!supplier_id) return res.status(400).json({ message: 'supplier_id обязателен' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [ins] = await conn.execute(
      `INSERT INTO supplier_addresses
       (supplier_id,label,type,formatted_address,city,street,house,building,entrance,region,country,
        is_precise_location,place_id,lat,lng,postal_code,comment,is_primary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        Number(supplier_id),
        nz(label),
        nz(type),
        nz(formatted_address),
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
        is_primary ? 1 : 0
      ]
    )

    // если пометили как основной — снимем флаг у остальных адресов поставщика
    if (is_primary) {
      await conn.execute(
        `UPDATE supplier_addresses SET is_primary=0 WHERE supplier_id=? AND id<>?`,
        [Number(supplier_id), ins.insertId]
      )
    }

    const [row] = await conn.execute('SELECT * FROM supplier_addresses WHERE id=?', [ins.insertId])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'suppliers',
      entity_id: Number(supplier_id),
      comment: 'Добавлен адрес поставщика',
      diff: row[0],
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
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Некорректный id' })
  if (version == null) return res.status(400).json({ message: 'Отсутствует version для проверки конфликтов' })

  const fields = [
    'label','type','formatted_address','city','street','house','building','entrance','region','country',
    'is_precise_location','place_id','lat','lng','postal_code','comment','is_primary'
  ]

  // нормализуем входные значения для известных полей
  const body = { ...req.body }
  if (Object.prototype.hasOwnProperty.call(body, 'country')) body.country = nz(up(body.country, 2))
  if (Object.prototype.hasOwnProperty.call(body, 'lat')) body.lat = num(body.lat)
  if (Object.prototype.hasOwnProperty.call(body, 'lng')) body.lng = num(body.lng)
  if (Object.prototype.hasOwnProperty.call(body, 'is_precise_location')) body.is_precise_location = body.is_precise_location ? 1 : 0
  if (Object.prototype.hasOwnProperty.call(body, 'is_primary')) body.is_primary = body.is_primary ? 1 : 0

  const set = []
  const vals = []
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      set.push(`\`${f}\`=?`)
      vals.push(nz(body[f]))
    }
  }

  // если нет пользовательских полей — нет изменений
  if (!set.length) return res.json({ message: 'Нет изменений' })

  // технические поля
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

    // optimistic по version
    const [upd] = await conn.execute(
      `UPDATE supplier_addresses SET ${set.join(', ')} WHERE id=? AND version=?`,
      [...vals, id, version]
    )

    if (!upd.affectedRows) {
      await conn.rollback()
      const [currentRows] = await db.execute('SELECT * FROM supplier_addresses WHERE id=?', [id])
      return res.status(409).json({
        message: 'Появились новые изменения. Обновите данные.',
        current: currentRows[0],
      })
    }

    // Если после апдейта адрес стал "Основной" — снимем флаг у остальных
    const newPrimary =
      Object.prototype.hasOwnProperty.call(body, 'is_primary')
        ? (body.is_primary ? 1 : 0)
        : oldData.is_primary
    if (newPrimary) {
      await conn.execute(
        `UPDATE supplier_addresses SET is_primary=0 WHERE supplier_id=? AND id<>?`,
        [oldData.supplier_id, id]
      )
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
   DELETE
   ====================== */
router.delete('/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Некорректный id' })

  try {
    const [old] = await db.execute('SELECT * FROM supplier_addresses WHERE id=?', [id])
    if (!old.length) return res.status(404).json({ message: 'Адрес не найден' })

    await db.execute('DELETE FROM supplier_addresses WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'suppliers',
      entity_id: Number(old[0].supplier_id),
      comment: 'Удалён адрес поставщика'
    })

    res.json({ message: 'Адрес удалён' })
  } catch (e) {
    console.error('DELETE /supplier-addresses/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления адреса' })
  }
})

module.exports = router
