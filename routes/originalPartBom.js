// routes/originalPartBom.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// helpers
const nz = (v) => (v === undefined || v === null ? null : String(v).trim() || null)

// запрет циклов: простая проверка достижимости child -> ... -> parent
async function wouldCreateCycle(parentId, childId) {
  if (parentId === childId) return true
  // рекурсивный CTE: может ли child достичь parent по цепочке children
  const [rows] = await db.execute(
    `
    WITH RECURSIVE chain AS (
      SELECT child_part_id AS node_id
      FROM original_part_bom
      WHERE parent_part_id = ?
      UNION ALL
      SELECT b.child_part_id
      FROM original_part_bom b
      JOIN chain c ON b.parent_part_id = c.node_id
    )
    SELECT 1 FROM chain WHERE node_id = ? LIMIT 1
    `,
    [childId, parentId]
  )
  return rows.length > 0
}

// ------------------------------------------------------------------
// GET /original-part-bom?parent_id=123  — состав конкретной сборки
// ------------------------------------------------------------------
router.get('/', auth, async (req, res) => {
  try {
    const parent_id = Number(req.query.parent_id)
    if (!Number.isFinite(parent_id)) {
      return res.status(400).json({ message: 'Нужно указать parent_id (число)' })
    }

    const [rows] = await db.execute(
      `
      SELECT b.parent_part_id, b.child_part_id, b.quantity,
             c.cat_number      AS child_cat_number,
             c.description_en  AS child_description_en,
             c.description_ru  AS child_description_ru
      FROM original_part_bom b
      JOIN original_parts c ON c.id = b.child_part_id
      WHERE b.parent_part_id = ?
      ORDER BY c.cat_number
      `,
      [parent_id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /original-part-bom error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------------
// POST /original-part-bom  — добавить строку в состав
// body: { parent_part_id, child_part_id, quantity }
// ------------------------------------------------------------------
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const parent_part_id = Number(req.body.parent_part_id)
    const child_part_id  = Number(req.body.child_part_id)
    const quantity       = req.body.quantity !== undefined ? Number(req.body.quantity) : 1

    if (!Number.isFinite(parent_part_id) || !Number.isFinite(child_part_id)) {
      return res.status(400).json({ message: 'parent_part_id и child_part_id обязательны и должны быть числами' })
    }
    if (quantity <= 0 || !Number.isFinite(quantity)) {
      return res.status(400).json({ message: 'quantity должен быть положительным числом' })
    }

    // проверим существование партов
    const [[p], [c]] = await Promise.all([
      db.execute('SELECT id FROM original_parts WHERE id=?', [parent_part_id]),
      db.execute('SELECT id FROM original_parts WHERE id=?', [child_part_id]),
    ])
    if (!p[0]) return res.status(400).json({ message: 'parent_part_id не найден' })
    if (!c[0]) return res.status(400).json({ message: 'child_part_id не найден' })

    // защита от циклов
    if (await wouldCreateCycle(parent_part_id, child_part_id)) {
      return res.status(409).json({ message: 'Добавление создаст цикл в BOM' })
    }

    // вставка (PK по паре не даст дублировать строку)
    await db.execute(
      'INSERT INTO original_part_bom (parent_part_id, child_part_id, quantity) VALUES (?,?,?)',
      [parent_part_id, child_part_id, quantity]
    )
    res.status(201).json({ message: 'Строка BOM добавлена' })
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Такая строка BOM уже существует' })
    }
    console.error('POST /original-part-bom error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------------
// PUT /original-part-bom  — обновить количество
// body: { parent_part_id, child_part_id, quantity }
// ------------------------------------------------------------------
router.put('/', auth, adminOnly, async (req, res) => {
  try {
    const parent_part_id = Number(req.body.parent_part_id)
    const child_part_id  = Number(req.body.child_part_id)
    const quantity       = req.body.quantity !== undefined ? Number(req.body.quantity) : undefined

    if (!Number.isFinite(parent_part_id) || !Number.isFinite(child_part_id)) {
      return res.status(400).json({ message: 'parent_part_id и child_part_id обязательны и должны быть числами' })
    }
    if (!(quantity > 0)) {
      return res.status(400).json({ message: 'quantity должен быть положительным числом' })
    }

    const [upd] = await db.execute(
      'UPDATE original_part_bom SET quantity=? WHERE parent_part_id=? AND child_part_id=?',
      [quantity, parent_part_id, child_part_id]
    )
    if (upd.affectedRows === 0) return res.status(404).json({ message: 'Строка BOM не найдена' })
    res.json({ message: 'Количество обновлено' })
  } catch (e) {
    console.error('PUT /original-part-bom error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------------
// DELETE /original-part-bom  — удалить строку
// body: { parent_part_id, child_part_id }
// ------------------------------------------------------------------
router.delete('/', auth, adminOnly, async (req, res) => {
  try {
    const parent_part_id = Number(req.body.parent_part_id)
    const child_part_id  = Number(req.body.child_part_id)
    if (!Number.isFinite(parent_part_id) || !Number.isFinite(child_part_id)) {
      return res.status(400).json({ message: 'parent_part_id и child_part_id обязательны и должны быть числами' })
    }

    const [del] = await db.execute(
      'DELETE FROM original_part_bom WHERE parent_part_id=? AND child_part_id=?',
      [parent_part_id, child_part_id]
    )
    if (del.affectedRows === 0) return res.status(404).json({ message: 'Строка BOM не найдена' })
    res.json({ message: 'Строка BOM удалена' })
  } catch (e) {
    console.error('DELETE /original-part-bom error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------------
// GET /original-part-bom/tree/:id — выдать дерево вниз (MySQL 8 CTE)
// ------------------------------------------------------------------
router.get('/tree/:id', auth, async (req, res) => {
  try {
    const rootId = Number(req.params.id)
    if (!Number.isFinite(rootId)) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      `
      WITH RECURSIVE bom AS (
        SELECT p.id AS node_id, p.cat_number, p.description_en, p.description_ru, 0 AS level, CAST(p.id AS CHAR(1024)) AS path, 1.0 AS mult_qty
        FROM original_parts p
        WHERE p.id = ?

        UNION ALL

        SELECT c.id, c.cat_number, c.description_en, c.description_ru, b.level + 1,
               CONCAT(b.path, '>', c.id), b.mult_qty * ob.quantity
        FROM bom b
        JOIN original_part_bom ob ON ob.parent_part_id = b.node_id
        JOIN original_parts c ON c.id = ob.child_part_id
      )
      SELECT * FROM bom ORDER BY level, path
      `,
      [rootId]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /original-part-bom/tree/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
