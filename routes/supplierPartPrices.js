// routes/supplierPartPrices.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// ----------------------------------------------
// GET /supplier-part-prices?supplier_part_id=123
// Возвращает историю цен, можно фильтровать по детали поставщика
// ----------------------------------------------
router.get('/', auth, async (req, res) => {
  try {
    const { supplier_part_id } = req.query
    let sql =
      `SELECT spp.*, sp.supplier_part_number, sp.supplier_id
         FROM supplier_part_prices spp
         JOIN supplier_parts sp ON sp.id = spp.supplier_part_id`
    const params = []

    if (supplier_part_id) {
      sql += ' WHERE spp.supplier_part_id=?'
      params.push(Number(supplier_part_id))
    }

    sql += ' ORDER BY spp.supplier_part_id, spp.date DESC'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении цен:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// POST /supplier-part-prices
// body: { supplier_part_id, price, date? }
// Добавляет новую запись в историю цен
// ----------------------------------------------
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const supplier_part_id = Number(req.body.supplier_part_id)
    const price = Number(req.body.price)
    const date = req.body.date ? new Date(req.body.date) : new Date()

    if (!Number.isFinite(supplier_part_id)) {
      return res.status(400).json({ message: 'supplier_part_id обязателен и должен быть числом' })
    }
    if (!(price > 0)) {
      return res.status(400).json({ message: 'price обязателен и должен быть положительным' })
    }
    if (isNaN(date.getTime())) {
      return res.status(400).json({ message: 'Некорректная дата' })
    }

    // проверим что деталь поставщика существует
    const [sp] = await db.execute('SELECT id FROM supplier_parts WHERE id=?', [supplier_part_id])
    if (!sp.length) return res.status(400).json({ message: 'Деталь поставщика не найдена' })

    await db.execute(
      'INSERT INTO supplier_part_prices (supplier_part_id, price, date) VALUES (?,?,?)',
      [supplier_part_id, price, date]
    )

    const [row] = await db.execute(
      'SELECT * FROM supplier_part_prices WHERE id = LAST_INSERT_ID()'
    )

    res.status(201).json(row[0])
  } catch (err) {
    console.error('Ошибка при добавлении цены:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// GET /supplier-part-prices/latest?supplier_part_id=123
// Возвращает последнюю цену по детали
// ----------------------------------------------
router.get('/latest', auth, async (req, res) => {
  try {
    const supplier_part_id = Number(req.query.supplier_part_id)
    if (!Number.isFinite(supplier_part_id)) {
      return res.status(400).json({ message: 'supplier_part_id обязателен' })
    }

    const [rows] = await db.execute(
      `SELECT spp.*, sp.supplier_part_number, sp.supplier_id
         FROM supplier_part_prices spp
         JOIN supplier_parts sp ON sp.id = spp.supplier_part_id
        WHERE spp.supplier_part_id=?
        ORDER BY spp.date DESC
        LIMIT 1`,
      [supplier_part_id]
    )

    if (!rows.length) return res.status(404).json({ message: 'Цены не найдены' })
    res.json(rows[0])
  } catch (err) {
    console.error('Ошибка при получении последней цены:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
