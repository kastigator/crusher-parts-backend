// routes/supplierPartPrices.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')

// helpers
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) =>
  v === undefined || v === null ? null : ('' + v).trim() || null
const numPos = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}
const parseDate = (v) => {
  if (v === undefined || v === null || v === '') return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
}
const normCurrency = (v) => {
  const s = nz(v)
  return s ? s.toUpperCase().slice(0, 3) : null
}
const fmtPrice = (rowOrPrice, currency) => {
  if (rowOrPrice == null) return ''
  if (typeof rowOrPrice === 'object' && rowOrPrice) {
    const p = rowOrPrice.price
    const c = rowOrPrice.currency
    return p == null ? '' : `${p}${c ? ' ' + c : ''}`
  }
  return `${rowOrPrice}${currency ? ' ' + currency : ''}`
}

async function getLatestPriceRow(partId) {
  const [rows] = await db.execute(
    `SELECT *
       FROM supplier_part_prices
      WHERE supplier_part_id = ?
      ORDER BY date DESC, id DESC
      LIMIT 1`,
    [partId]
  )
  return rows[0] || null
}

/** LIST: GET /supplier-part-prices?supplier_part_id=&supplier_id=&date_from=&date_to= */
router.get('/', async (req, res) => {
  try {
    const supplier_part_id =
      req.query.supplier_part_id !== undefined
        ? toId(req.query.supplier_part_id)
        : undefined
    const supplier_id =
      req.query.supplier_id !== undefined ? toId(req.query.supplier_id) : undefined
    const date_from = parseDate(req.query.date_from)
    const date_to = parseDate(req.query.date_to)

    if (supplier_part_id !== undefined && !supplier_part_id) {
      return res
        .status(400)
        .json({ message: 'supplier_part_id должен быть числом' })
    }
    if (supplier_id !== undefined && !supplier_id) {
      return res
        .status(400)
        .json({ message: 'supplier_id должен быть числом' })
    }
    if (req.query.date_from && !date_from) {
      return res
        .status(400)
        .json({ message: 'Некорректная дата в date_from' })
    }
    if (req.query.date_to && !date_to) {
      return res
        .status(400)
        .json({ message: 'Некорректная дата в date_to' })
    }

    const where = []
    const params = []

    let sql = `
      SELECT
        spp.*,
        sp.supplier_part_number,
        sp.supplier_id
      FROM supplier_part_prices spp
      JOIN supplier_parts sp ON sp.id = spp.supplier_part_id
    `
    if (supplier_part_id !== undefined) {
      where.push('spp.supplier_part_id = ?')
      params.push(supplier_part_id)
    }
    if (supplier_id !== undefined) {
      where.push('sp.supplier_id = ?')
      params.push(supplier_id)
    }
    if (date_from) {
      where.push('spp.date >= ?')
      params.push(date_from)
    }
    if (date_to) {
      where.push('spp.date <= ?')
      params.push(date_to)
    }

    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY spp.supplier_part_id, spp.date DESC, spp.id DESC'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /supplier-part-prices error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/** CREATE: POST /supplier-part-prices */
router.post('/', async (req, res) => {
  try {
    const supplier_part_id = toId(req.body.supplier_part_id)
    const price = numPos(req.body.price)
    const currency = normCurrency(req.body.currency)
    const comment = nz(req.body.comment)
    const date = parseDate(req.body.date) || new Date()

    if (!supplier_part_id) {
      return res.status(400).json({
        message: 'supplier_part_id обязателен и должен быть числом',
      })
    }
    if (price === null) {
      return res.status(400).json({
        message: 'price обязателен и должен быть положительным',
      })
    }

    const [[sp]] = await db.execute(
      'SELECT id FROM supplier_parts WHERE id=?',
      [supplier_part_id]
    )
    if (!sp) {
      return res
        .status(400)
        .json({ message: 'Деталь поставщика не найдена' })
    }

    const prevLatest = await getLatestPriceRow(supplier_part_id)

    const [ins] = await db.execute(
      `INSERT INTO supplier_part_prices
         (supplier_part_id, price, currency, date, comment)
       VALUES (?,?,?,?,?)`,
      [supplier_part_id, price, currency, date, comment]
    )

    const [[row]] = await db.execute(
      'SELECT * FROM supplier_part_prices WHERE id = ?',
      [ins.insertId]
    )

    const currLatest = await getLatestPriceRow(supplier_part_id)

    if (!prevLatest || (currLatest && currLatest.id !== prevLatest.id)) {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: supplier_part_id,
        field_changed: 'latest_price',
        old_value: fmtPrice(prevLatest),
        new_value: fmtPrice(currLatest),
        comment: 'Добавлена цена',
      })
    } else {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: supplier_part_id,
        field_changed: 'price_entry',
        old_value: '',
        new_value: `${fmtPrice(
          price,
          currency
        )} @ ${new Date(date).toISOString().slice(0, 10)}`,
        comment: 'Добавлена запись цены (не последняя)',
      })
    }

    res.status(201).json(row)
  } catch (err) {
    console.error('POST /supplier-part-prices error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/** UPDATE ONE: PUT /supplier-part-prices/:id */
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const price =
      req.body.price !== undefined ? numPos(req.body.price) : undefined
    const currency =
      req.body.currency !== undefined
        ? normCurrency(req.body.currency)
        : undefined
    const comment =
      req.body.comment !== undefined ? nz(req.body.comment) : undefined
    const date =
      req.body.date !== undefined ? parseDate(req.body.date) : undefined

    const [[exists]] = await db.execute(
      'SELECT * FROM supplier_part_prices WHERE id=?',
      [id]
    )
    if (!exists) {
      return res.status(404).json({ message: 'Запись не найдена' })
    }

    const prevLatest = await getLatestPriceRow(exists.supplier_part_id)

    await db.execute(
      `UPDATE supplier_part_prices
          SET price    = COALESCE(?, price),
              currency = COALESCE(?, currency),
              date     = COALESCE(?, date),
              comment  = COALESCE(?, comment)
        WHERE id=?`,
      [price, currency, date, comment, id]
    )

    const [[row]] = await db.execute(
      'SELECT * FROM supplier_part_prices WHERE id=?',
      [id]
    )

    const currLatest = await getLatestPriceRow(exists.supplier_part_id)

    if (
      !prevLatest ||
      !currLatest ||
      prevLatest.id !== currLatest.id ||
      prevLatest.price !== currLatest.price ||
      prevLatest.currency !== currLatest.currency
    ) {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: exists.supplier_part_id,
        field_changed: 'latest_price',
        old_value: fmtPrice(prevLatest),
        new_value: fmtPrice(currLatest),
        comment: 'Изменена запись цены',
      })
    } else {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: exists.supplier_part_id,
        field_changed: 'price_entry_updated',
        old_value: '',
        new_value: `${fmtPrice(row)} @ ${new Date(
          row.date
        ).toISOString().slice(0, 10)}`,
        comment: 'Обновлена запись цены (не последняя)',
      })
    }

    res.json(row)
  } catch (err) {
    console.error('PUT /supplier-part-prices/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/** DELETE ONE: DELETE /supplier-part-prices/:id */
router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [[exists]] = await db.execute(
      'SELECT * FROM supplier_part_prices WHERE id=?',
      [id]
    )
    if (!exists) {
      return res.status(404).json({ message: 'Запись не найдена' })
    }

    const prevLatest = await getLatestPriceRow(exists.supplier_part_id)

    const [del] = await db.execute(
      'DELETE FROM supplier_part_prices WHERE id=?',
      [id]
    )
    if (del.affectedRows === 0) {
      return res.status(404).json({ message: 'Запись не найдена' })
    }

    const currLatest = await getLatestPriceRow(exists.supplier_part_id)

    if (prevLatest && prevLatest.id === id) {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: exists.supplier_part_id,
        field_changed: 'latest_price',
        old_value: fmtPrice(prevLatest),
        new_value: fmtPrice(currLatest),
        comment: 'Удалена последняя запись цены',
      })
    } else {
      await logActivity({
        req,
        action: 'update',
        entity_type: 'supplier_parts',
        entity_id: exists.supplier_part_id,
        field_changed: 'price_entry_removed',
        old_value: `${fmtPrice(exists)} @ ${new Date(
          exists.date
        ).toISOString().slice(0, 10)}`,
        new_value: '',
        comment: 'Удалена запись цены (не последняя)',
      })
    }

    res.json({ message: 'Запись удалена' })
  } catch (err) {
    console.error('DELETE /supplier-part-prices/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/** LAST PRICE: GET /supplier-part-prices/latest?supplier_part_id= */
router.get('/latest', async (req, res) => {
  try {
    const supplier_part_id = toId(req.query.supplier_part_id)
    if (!supplier_part_id) {
      return res
        .status(400)
        .json({ message: 'supplier_part_id обязателен' })
    }

    const [rows] = await db.execute(
      `SELECT
         spp.*,
         sp.supplier_part_number,
         sp.supplier_id
       FROM supplier_part_prices spp
       JOIN supplier_parts sp ON sp.id = spp.supplier_part_id
      WHERE spp.supplier_part_id = ?
      ORDER BY spp.date DESC, spp.id DESC
      LIMIT 1`,
      [supplier_part_id]
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'Цены не найдены' })
    }

    res.json(rows[0])
  } catch (err) {
    console.error('GET /supplier-part-prices/latest error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
