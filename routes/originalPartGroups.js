// routes/originalPartGroups.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')

/**
 * ВНИМАНИЕ:
 * Доступ (auth + requireTabAccess('/original-parts')) навешивается
 * снаружи в routerIndex.js. Здесь только бизнес-логика.
 */

// helpers
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) =>
  v === undefined || v === null ? null : ('' + v).trim() || null

/* --------------------------------------------------
   GET /original-part-groups
   Список всех групп
-------------------------------------------------- */
router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM original_part_groups ORDER BY sort_order ASC, name ASC'
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /original-part-groups error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* --------------------------------------------------
   POST /original-part-groups
   Создать группу
   body: { name, description?, sort_order? }
-------------------------------------------------- */
router.post('/', async (req, res) => {
  try {
    const name = nz(req.body.name)
    if (!name) {
      return res.status(400).json({ message: 'Поле "name" обязательно' })
    }

    const description = nz(req.body.description)
    const sort_order = Number.isFinite(Number(req.body.sort_order))
      ? Number(req.body.sort_order)
      : 0

    const [ins] = await db.execute(
      'INSERT INTO original_part_groups (name, description, sort_order) VALUES (?,?,?)',
      [name, description, sort_order]
    )

    const [[row]] = await db.execute(
      'SELECT * FROM original_part_groups WHERE id=?',
      [ins.insertId]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'original_part_groups',
      entity_id: row.id,
      comment: `Создана группа деталей: ${row.name}`,
    })

    res.status(201).json(row)
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        type: 'duplicate',
        field: 'name',
        message: 'Группа с таким именем уже существует',
      })
    }
    console.error('POST /original-part-groups error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* --------------------------------------------------
   PUT /original-part-groups/:id
   Обновить name/description/sort_order
-------------------------------------------------- */
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const name = nz(req.body.name)
    const description = nz(req.body.description)
    const sort_order =
      req.body.sort_order !== undefined ? Number(req.body.sort_order) : null

    const [[old]] = await db.execute(
      'SELECT * FROM original_part_groups WHERE id=?',
      [id]
    )
    if (!old) return res.status(404).json({ message: 'Группа не найдена' })

    await db.execute(
      `UPDATE original_part_groups
          SET name        = COALESCE(?, name),
              description = COALESCE(?, description),
              sort_order  = COALESCE(?, sort_order)
        WHERE id = ?`,
      [name, description, sort_order, id]
    )

    const [[fresh]] = await db.execute(
      'SELECT * FROM original_part_groups WHERE id=?',
      [id]
    )

    await logActivity({
      req,
      action: 'update',
      entity_type: 'original_part_groups',
      entity_id: id,
      comment: `Обновлена группа деталей: ${old.name} → ${fresh.name}`,
    })

    res.json(fresh)
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        type: 'duplicate',
        field: 'name',
        message: 'Группа с таким именем уже существует',
      })
    }
    console.error('PUT /original-part-groups/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* --------------------------------------------------
   DELETE /original-part-groups/:id
   Удалить группу: у связанных деталей group_id станет NULL
   (выполняем безопасно в транзакции)
-------------------------------------------------- */
router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[exists]] = await conn.execute(
      'SELECT * FROM original_part_groups WHERE id=? FOR UPDATE',
      [id]
    )
    if (!exists) {
      await conn.rollback()
      return res.status(404).json({ message: 'Группа не найдена' })
    }

    // отвязываем детали от группы (на случай, если в БД нет ON DELETE SET NULL)
    await conn.execute(
      'UPDATE original_parts SET group_id = NULL WHERE group_id = ?',
      [id]
    )

    await conn.execute('DELETE FROM original_part_groups WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'original_part_groups',
      entity_id: id,
      comment: `Удалена группа деталей: ${exists.name}`,
    })

    await conn.commit()
    res.json({ message: 'Группа удалена' })
  } catch (e) {
    await conn.rollback()
    console.error('DELETE /original-part-groups/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
