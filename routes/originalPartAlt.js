// routes/originalPartAlt.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')

/**
 * ВАЖНО:
 *  - authMiddleware и requireTabAccess('/original-parts')
 *    навешиваются СНАРУЖИ в routerIndex.js.
 *  - Здесь только бизнес-логика альтернатив для оригинальных деталей.
 */

// ------------------------------
// helpers
// ------------------------------
const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const nz = (v) =>
  v === undefined || v === null ? null : ('' + v).trim() || null

const normLimit = (v, def = 200, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}
const normOffset = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

/* ================================================================
   GET /original-part-alt
   Список групп альтернатив по original_part_id (+ пагинация по группам)
   /original-part-alt?original_part_id=123&limit=200&offset=0
================================================================ */
router.get('/', async (req, res) => {
  try {
    const original_part_id = toId(req.query.original_part_id)
    if (!original_part_id) {
      return res
        .status(400)
        .json({ message: 'Нужно указать original_part_id (число)' })
    }

    const limit = normLimit(req.query.limit, 200, 1000)
    const offset = normOffset(req.query.offset)

    const [groups] = await db.execute(
      `SELECT g.*
         FROM original_part_alt_groups g
        WHERE g.original_part_id = ?
        ORDER BY g.id DESC
        LIMIT ? OFFSET ?`,
      [original_part_id, limit, offset]
    )

    if (!groups.length) return res.json([])

    const ids = groups.map((g) => g.id)
    const placeholders = ids.map(() => '?').join(',')

    const [items] = await db.execute(
      `SELECT 
          i.group_id,
          i.alt_part_id,
          i.note,
          p.cat_number,
          p.description_ru,
          p.description_en,
          m.model_name,
          mf.name AS manufacturer_name
        FROM original_part_alt_items i
        JOIN original_parts p           ON p.id = i.alt_part_id
        JOIN equipment_models m         ON m.id = p.equipment_model_id
        JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
       WHERE i.group_id IN (${placeholders})
       ORDER BY i.group_id, p.cat_number`,
      ids
    )

    const byGroup = new Map()
    groups.forEach((g) => {
      byGroup.set(g.id, { ...g, items: [] })
    })

    items.forEach((r) => {
      const g = byGroup.get(r.group_id)
      if (!g) return
      g.items.push({
        alt_part_id: r.alt_part_id,
        note: r.note,
        cat_number: r.cat_number,
        description_ru: r.description_ru,
        description_en: r.description_en,
        model_name: r.model_name,
        manufacturer_name: r.manufacturer_name,
      })
    })

    res.json(Array.from(byGroup.values()))
  } catch (e) {
    console.error('GET /original-part-alt error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   GET /original-part-alt/:id — одна группа с элементами
================================================================ */
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [[group]] = await db.execute(
      'SELECT * FROM original_part_alt_groups WHERE id=?',
      [id]
    )
    if (!group) return res.status(404).json({ message: 'Группа не найдена' })

    const [items] = await db.execute(
      `SELECT 
          i.alt_part_id,
          i.note,
          p.cat_number,
          p.description_ru,
          p.description_en,
          m.model_name,
          mf.name AS manufacturer_name
        FROM original_part_alt_items i
        JOIN original_parts p           ON p.id = i.alt_part_id
        JOIN equipment_models m         ON m.id = p.equipment_model_id
        JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
       WHERE i.group_id = ?
       ORDER BY p.cat_number`,
      [id]
    )

    res.json({
      ...group,
      items: items.map((r) => ({
        alt_part_id: r.alt_part_id,
        note: r.note,
        cat_number: r.cat_number,
        description_ru: r.description_ru,
        description_en: r.description_en,
        model_name: r.model_name,
        manufacturer_name: r.manufacturer_name,
      })),
    })
  } catch (e) {
    console.error('GET /original-part-alt/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   POST /original-part-alt — создать группу альтернатив
   body: { original_part_id, name?, comment? }
================================================================ */
router.post('/', async (req, res) => {
  try {
    const original_part_id = toId(req.body.original_part_id)
    if (!original_part_id) {
      return res
        .status(400)
        .json({ message: 'original_part_id обязателен и должен быть числом' })
    }

    const [[op]] = await db.execute(
      'SELECT id, cat_number FROM original_parts WHERE id=?',
      [original_part_id]
    )
    if (!op) {
      return res.status(400).json({ message: 'Оригинальная деталь не найдена' })
    }

    const name = nz(req.body.name)
    const comment = nz(req.body.comment)

    const [ins] = await db.execute(
      'INSERT INTO original_part_alt_groups (original_part_id, name, comment) VALUES (?,?,?)',
      [original_part_id, name, comment]
    )

    const [[row]] = await db.execute(
      'SELECT * FROM original_part_alt_groups WHERE id=?',
      [ins.insertId]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'original_part_alt_groups',
      entity_id: row.id,
      comment: `Создана группа альтернатив для ${op.cat_number}${name ? ` (${name})` : ''}`,
    })

    res.status(201).json(row)
  } catch (e) {
    console.error('POST /original-part-alt error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   PUT /original-part-alt/:id — обновить name/comment
   body: { name?, comment? }
================================================================ */
router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const name = nz(req.body.name)
    const comment = nz(req.body.comment)

    const [[old]] = await db.execute(
      'SELECT * FROM original_part_alt_groups WHERE id=?',
      [id]
    )
    if (!old) return res.status(404).json({ message: 'Группа не найдена' })

    await db.execute(
      `UPDATE original_part_alt_groups
          SET name    = COALESCE(?, name),
              comment = COALESCE(?, comment)
        WHERE id = ?`,
      [name, comment, id]
    )

    const [[fresh]] = await db.execute(
      'SELECT * FROM original_part_alt_groups WHERE id=?',
      [id]
    )

    await logActivity({
      req,
      action: 'update',
      entity_type: 'original_part_alt_groups',
      entity_id: id,
      comment: `Обновлена группа альтернатив (name: ${old.name || '-'} → ${fresh.name || '-'})`,
    })

    res.json(fresh)
  } catch (e) {
    console.error('PUT /original-part-alt/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   DELETE /original-part-alt/:id — удалить группу (и её элементы)
================================================================ */
router.delete('/:id', async (req, res) => {
  let conn
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [[exists]] = await conn.execute(
      'SELECT * FROM original_part_alt_groups WHERE id=?',
      [id]
    )
    if (!exists) {
      await conn.rollback()
      return res.status(404).json({ message: 'Группа не найдена' })
    }

    // если в БД нет ON DELETE CASCADE — удалим элементы вручную
    await conn.execute(
      'DELETE FROM original_part_alt_items WHERE group_id=?',
      [id]
    )
    await conn.execute('DELETE FROM original_part_alt_groups WHERE id=?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'original_part_alt_groups',
      entity_id: id,
      comment: `Удалена группа альтернатив (original_part_id=${exists.original_part_id}, name=${exists.name || '-'})`,
    })

    await conn.commit()
    res.json({ message: 'Группа удалена' })
  } catch (e) {
    if (conn) {
      try { await conn.rollback() } catch (_) {}
    }
    console.error('DELETE /original-part-alt/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    if (conn) {
      try { conn.release() } catch (_) {}
    }
  }
})

/* ================================================================
   POST /original-part-alt/:id/items — добавить альтернативу
   body: { alt_part_id, note? }
================================================================ */
router.post('/:id/items', async (req, res) => {
  try {
    const group_id = toId(req.params.id)
    const alt_part_id = toId(req.body.alt_part_id)
    const note = nz(req.body.note)

    if (!group_id || !alt_part_id) {
      return res
        .status(400)
        .json({ message: 'group_id и alt_part_id должны быть числами' })
    }

    const [[group]] = await db.execute(
      'SELECT * FROM original_part_alt_groups WHERE id=?',
      [group_id]
    )
    if (!group)
      return res.status(400).json({ message: 'Группа альтернатив не найдена' })

    const [[alt]] = await db.execute(
      'SELECT id, cat_number FROM original_parts WHERE id=?',
      [alt_part_id]
    )
    if (!alt)
      return res.status(400).json({ message: 'Альтернативная деталь не найдена' })

    if (group.original_part_id === alt_part_id) {
      return res
        .status(400)
        .json({ message: 'Нельзя указать ту же самую деталь как альтернативу' })
    }

    try {
      await db.execute(
        'INSERT INTO original_part_alt_items (group_id, alt_part_id, note) VALUES (?,?,?)',
        [group_id, alt_part_id, note]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Эта деталь уже есть в группе' })
      }
      if (e && e.errno === 1452) {
        return res
          .status(409)
          .json({ message: 'Нарушение ссылочной целостности (неверные идентификаторы)' })
      }
      throw e
    }

    await logActivity({
      req,
      action: 'create',
      entity_type: 'original_part_alt_items',
      entity_id: group_id,
      field_changed: `alt_part:${alt_part_id}`,
      old_value: null,
      new_value: note || '',
      comment: `Альтернативы: добавлена деталь ${alt.cat_number}`,
    })

    res.status(201).json({ message: 'Альтернатива добавлена' })
  } catch (e) {
    console.error('POST /original-part-alt/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ================================================================
   DELETE /original-part-alt/:id/items — удалить альтернативу
   body: { alt_part_id }
================================================================ */
router.delete('/:id/items', async (req, res) => {
  try {
    const group_id = toId(req.params.id)
    const alt_part_id = toId(req.body.alt_part_id ?? req.query.alt_part_id)

    if (!group_id || !alt_part_id) {
      return res.status(400).json({ message: 'Неверные параметры' })
    }

    const [oldRows] = await db.execute(
      'SELECT note FROM original_part_alt_items WHERE group_id=? AND alt_part_id=?',
      [group_id, alt_part_id]
    )
    if (!oldRows.length)
      return res.status(404).json({ message: 'Позиция не найдена' })

    const [del] = await db.execute(
      'DELETE FROM original_part_alt_items WHERE group_id=? AND alt_part_id=?',
      [group_id, alt_part_id]
    )
    if (del.affectedRows === 0)
      return res.status(404).json({ message: 'Позиция не найдена' })

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'original_part_alt_items',
      entity_id: group_id,
      field_changed: `alt_part:${alt_part_id}`,
      old_value: oldRows[0].note || '',
      comment: 'Альтернативы: удалена позиция',
    })

    res.json({ message: 'Альтернатива удалена' })
  } catch (e) {
    console.error('DELETE /original-part-alt/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
