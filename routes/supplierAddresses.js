const express = require('express')
const db = require('../utils/db')
const router = express.Router()
const auth = require('../middleware/authMiddleware')

const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => (v === '' || v === undefined ? null : v)

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

router.get('/:id', async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM supplier_addresses WHERE id=?', [req.params.id])
  if (!rows.length) return res.status(404).json({ message: 'Адрес не найден' })
  res.json(rows[0])
})

router.post('/', auth, async (req, res) => {
  const {
    supplier_id, label, type, formatted_address, city, street, house, building, entrance,
    region, country, is_precise_location, place_id, lat, lng, postal_code, comment, is_primary
  } = req.body

  if (!supplier_id) return res.status(400).json({ message: 'supplier_id обязателен' })

  try {
    const [ins] = await db.execute(
      `INSERT INTO supplier_addresses
       (supplier_id,label,type,formatted_address,city,street,house,building,entrance,region,country,
        is_precise_location,place_id,lat,lng,postal_code,comment,is_primary)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        Number(supplier_id), nz(label), nz(type), nz(formatted_address), nz(city), nz(street), nz(house), nz(building),
        nz(entrance), nz(region), nz(country), is_precise_location ? 1 : 0, nz(place_id), nz(lat), nz(lng),
        nz(postal_code), nz(comment), is_primary ? 1 : 0
      ]
    )

    await logActivity({ req, action: 'create', entity_type: 'supplier_addresses', entity_id: ins.insertId })
    const [row] = await db.execute('SELECT * FROM supplier_addresses WHERE id=?', [ins.insertId])
    res.status(201).json(row[0])
  } catch (e) {
    console.error('POST /supplier-addresses error', e)
    res.status(500).json({ message: 'Ошибка добавления адреса' })
  }
})

router.put('/:id', auth, async (req, res) => {
  const { updated_at } = req.body
  if (!updated_at) return res.status(400).json({ message: 'Отсутствует updated_at' })

  const fields = [
    'label','type','formatted_address','city','street','house','building','entrance','region','country',
    'is_precise_location','place_id','lat','lng','postal_code','comment','is_primary'
  ]
  const set = []
  const vals = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      set.push(`\`${f}\`=?`)
      vals.push(f === 'is_precise_location' || f === 'is_primary' ? (req.body[f] ? 1 : 0) : nz(req.body[f]))
    }
  }
  if (!set.length) return res.json({ message: 'Нет изменений' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [oldRows] = await conn.execute('SELECT * FROM supplier_addresses WHERE id=?', [req.params.id])
    if (!oldRows.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Адрес не найден' })
    }
    const oldData = oldRows[0]

    const [upd] = await conn.execute(
      `UPDATE supplier_addresses SET ${set.join(', ')} WHERE id=? AND updated_at=?`,
      [...vals, req.params.id, updated_at]
    )
    if (!upd.affectedRows) {
      await conn.rollback()
      return res.status(409).json({ message: 'Появились новые изменения. Обновите данные.' })
    }

    const [fresh] = await conn.execute('SELECT * FROM supplier_addresses WHERE id=?', [req.params.id])

    await logFieldDiffs({
      req,
      oldData,
      newData: fresh[0],
      entity_type: 'supplier_addresses',
      entity_id: Number(req.params.id)
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

router.delete('/:id', auth, async (req, res) => {
  try {
    const [old] = await db.execute('SELECT * FROM supplier_addresses WHERE id=?', [req.params.id])
    if (!old.length) return res.status(404).json({ message: 'Адрес не найден' })

    await db.execute('DELETE FROM supplier_addresses WHERE id=?', [req.params.id])
    await logActivity({ req, action: 'delete', entity_type: 'supplier_addresses', entity_id: Number(req.params.id) })
    res.json({ message: 'Адрес удалён' })
  } catch (e) {
    console.error('DELETE /supplier-addresses/:id error', e)
    res.status(500).json({ message: 'Ошибка удаления адреса' })
  }
})

module.exports = router
