// routes/supplierParts.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// Получить все детали поставщика с привязанными оригиналами
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT sp.*, GROUP_CONCAT(op.cat_number) AS original_cat_numbers
      FROM supplier_parts sp
      LEFT JOIN supplier_part_originals spo ON sp.id = spo.supplier_part_id
      LEFT JOIN original_parts op ON spo.original_part_id = op.id
      GROUP BY sp.id
    `)
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении деталей поставщиков:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// Добавить деталь поставщика
router.post('/', auth, adminOnly, async (req, res) => {
  const {
    supplier_id,
    supplier_part_number,
    original_part_cat_number,
    price,
    price_date
  } = req.body

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    // 1. Создаём запись в supplier_parts
    const [spResult] = await conn.execute(
      'INSERT INTO supplier_parts (supplier_id, supplier_part_number) VALUES (?, ?)',
      [supplier_id, supplier_part_number]
    )
    const supplier_part_id = spResult.insertId

    // 2. Ищем original_part_id по cat_number
    const [originalRows] = await conn.execute(
      'SELECT id FROM original_parts WHERE cat_number = ?',
      [original_part_cat_number]
    )
    if (!originalRows.length) {
      throw new Error(`Оригинальная деталь с cat_number "${original_part_cat_number}" не найдена`)
    }
    const original_part_id = originalRows[0].id

    // 3. Вставляем связь
    try {
      await conn.execute(
        'INSERT INTO supplier_part_originals (supplier_part_id, original_part_id) VALUES (?, ?)',
        [supplier_part_id, original_part_id]
      )
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        throw new Error('Такая связь поставщик ↔ оригинал уже существует')
      }
      throw e
    }

    // 4. Сохраняем цену
    if (price) {
      await conn.execute(
        'INSERT INTO supplier_part_prices (supplier_part_id, price, date) VALUES (?, ?, ?)',
        [supplier_part_id, price, price_date || new Date()]
      )
    }

    await conn.commit()
    res.status(201).json({ message: 'Деталь поставщика добавлена' })
  } catch (err) {
    await conn.rollback()
    console.error('Ошибка при добавлении детали поставщика:', err.message)
    res.status(500).json({ message: err.message || 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

// Обновить номер детали и/или цену
router.put('/:id', auth, adminOnly, async (req, res) => {
  const { supplier_part_number, price, price_date } = req.body

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    // 1. Обновить номер
    if (supplier_part_number) {
      await conn.execute(
        'UPDATE supplier_parts SET supplier_part_number=? WHERE id=?',
        [supplier_part_number, req.params.id]
      )
    }

    // 2. Добавить новую цену
    if (price) {
      await conn.execute(
        'INSERT INTO supplier_part_prices (supplier_part_id, price, date) VALUES (?, ?, ?)',
        [req.params.id, price, price_date || new Date()]
      )
    }

    await conn.commit()
    res.json({ message: 'Деталь обновлена' })
  } catch (err) {
    await conn.rollback()
    console.error('Ошибка при обновлении детали поставщика:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

// Удалить деталь поставщика и связанные записи
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    await conn.execute('DELETE FROM supplier_part_originals WHERE supplier_part_id = ?', [req.params.id])
    await conn.execute('DELETE FROM supplier_part_prices WHERE supplier_part_id = ?', [req.params.id])
    await conn.execute('DELETE FROM supplier_parts WHERE id = ?', [req.params.id])

    await conn.commit()
    res.json({ message: 'Деталь удалена' })
  } catch (err) {
    await conn.rollback()
    console.error('Ошибка при удалении детали поставщика:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
