// routes/originalPartSubstitutions.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// ----------------------------------------------
// Получить группы замен по оригинальной детали
// GET /original-part-substitutions?original_part_id=123
// ----------------------------------------------
router.get('/', auth, async (req, res) => {
  try {
    const original_part_id = Number(req.query.original_part_id)
    if (!Number.isFinite(original_part_id)) {
      return res.status(400).json({ message: 'Нужно указать original_part_id (число)' })
    }

    const [groups] = await db.execute(
      `SELECT s.*
         FROM original_part_substitutions s
        WHERE s.original_part_id = ?
        ORDER BY s.id DESC`,
      [original_part_id]
    )

    if (!groups.length) return res.json([])

    const ids = groups.map(g => g.id)
    const [items] = await db.execute(
      `SELECT i.substitution_id, i.supplier_part_id, i.quantity,
              sp.supplier_id, sp.supplier_part_number, sp.description
         FROM original_part_substitution_items i
         JOIN supplier_parts sp ON sp.id = i.supplier_part_id
        WHERE i.substitution_id IN (${ids.map(() => '?').join(',')})
        ORDER BY i.substitution_id`,
      ids
    )

    const byGroup = new Map()
    groups.forEach(g => byGroup.set(g.id, { ...g, items: [] }))
    items.forEach(r => byGroup.get(r.substitution_id)?.items.push(r))

    res.json(Array.from(byGroup.values()))
  } catch (e) {
    console.error('GET /original-part-substitutions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// Создать группу замен
// POST /original-part-substitutions
// body: { original_part_id, name?, comment? }
// ----------------------------------------------
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const original_part_id = Number(req.body.original_part_id)
    if (!Number.isFinite(original_part_id)) {
      return res.status(400).json({ message: 'original_part_id обязателен (число)' })
    }
    const name = req.body.name?.trim?.() || null
    const comment = req.body.comment?.trim?.() || null

    const [op] = await db.execute('SELECT id FROM original_parts WHERE id=?', [original_part_id])
    if (!op.length) return res.status(400).json({ message: 'Оригинальная деталь не найдена' })

    const [ins] = await db.execute(
      'INSERT INTO original_part_substitutions (original_part_id, name, comment) VALUES (?,?,?)',
      [original_part_id, name, comment]
    )
    const [row] = await db.execute('SELECT * FROM original_part_substitutions WHERE id=?', [ins.insertId])
    res.status(201).json(row[0])
  } catch (e) {
    console.error('POST /original-part-substitutions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// Удалить группу замен (каскадом удалятся её позиции)
// DELETE /original-part-substitutions/:id
// ----------------------------------------------
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT id FROM original_part_substitutions WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Группа не найдена' })

    await db.execute('DELETE FROM original_part_substitutions WHERE id=?', [id])
    res.json({ message: 'Группа удалена' })
  } catch (e) {
    console.error('DELETE /original-part-substitutions/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// Добавить позицию в группу
// POST /original-part-substitutions/:id/items
// body: { supplier_part_id, quantity }
// ----------------------------------------------
router.post('/:id/items', auth, adminOnly, async (req, res) => {
  try {
    const substitution_id = Number(req.params.id)
    const supplier_part_id = Number(req.body.supplier_part_id)
    const quantity = req.body.quantity !== undefined ? Number(req.body.quantity) : 1
    if (!Number.isFinite(substitution_id) || !Number.isFinite(supplier_part_id)) {
      return res.status(400).json({ message: 'substitution_id и supplier_part_id должны быть числами' })
    }
    if (!(quantity > 0)) return res.status(400).json({ message: 'quantity должен быть > 0' })

    const [[g], [sp]] = await Promise.all([
      db.execute('SELECT id FROM original_part_substitutions WHERE id=?', [substitution_id]),
      db.execute('SELECT id FROM supplier_parts WHERE id=?', [supplier_part_id]),
    ])
    if (!g[0]) return res.status(400).json({ message: 'Группа замен не найдена' })
    if (!sp[0]) return res.status(400).json({ message: 'Деталь поставщика не найдена' })

    await db.execute(
      'INSERT INTO original_part_substitution_items (substitution_id, supplier_part_id, quantity) VALUES (?,?,?)',
      [substitution_id, supplier_part_id, quantity]
    )
    res.status(201).json({ message: 'Позиция добавлена' })
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Эта деталь уже есть в группе' })
    }
    console.error('POST /original-part-substitutions/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// Изменить количество позиции
// PUT /original-part-substitutions/:id/items
// body: { supplier_part_id, quantity }
// ----------------------------------------------
router.put('/:id/items', auth, adminOnly, async (req, res) => {
  try {
    const substitution_id = Number(req.params.id)
    const supplier_part_id = Number(req.body.supplier_part_id)
    const quantity = Number(req.body.quantity)
    if (!Number.isFinite(substitution_id) || !Number.isFinite(supplier_part_id) || !(quantity > 0)) {
      return res.status(400).json({ message: 'Неверные параметры' })
    }

    const [upd] = await db.execute(
      'UPDATE original_part_substitution_items SET quantity=? WHERE substitution_id=? AND supplier_part_id=?',
      [quantity, substitution_id, supplier_part_id]
    )
    if (upd.affectedRows === 0) return res.status(404).json({ message: 'Позиция не найдена' })
    res.json({ message: 'Количество обновлено' })
  } catch (e) {
    console.error('PUT /original-part-substitutions/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ----------------------------------------------
// Удалить позицию
// DELETE /original-part-substitutions/:id/items
// body: { supplier_part_id }
// ----------------------------------------------
router.delete('/:id/items', auth, adminOnly, async (req, res) => {
  try {
    const substitution_id = Number(req.params.id)
    const supplier_part_id = Number(req.body.supplier_part_id)
    if (!Number.isFinite(substitution_id) || !Number.isFinite(supplier_part_id)) {
      return res.status(400).json({ message: 'Неверные параметры' })
    }

    const [del] = await db.execute(
      'DELETE FROM original_part_substitution_items WHERE substitution_id=? AND supplier_part_id=?',
      [substitution_id, supplier_part_id]
    )
    if (del.affectedRows === 0) return res.status(404).json({ message: 'Позиция не найдена' })
    res.json({ message: 'Позиция удалена' })
  } catch (e) {
    console.error('DELETE /original-part-substitutions/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
