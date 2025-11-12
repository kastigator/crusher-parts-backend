// routes/originalPartSubstitutions.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const auth = require('../middleware/authMiddleware')
const checkTabAccess = require('../middleware/checkTabAccess')
const logActivity = require('../utils/logActivity')

const tabGuard = checkTabAccess('/original-parts')

// helpers
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null }
const nz = (v) => (v === undefined || v === null ? null : ('' + v).trim() || null)
const normMode = (m) => {
  const v = ('' + (m ?? 'ANY')).toUpperCase()
  return v === 'ALL' ? 'ALL' : 'ANY'
}

/* ----------------------------------------------
   Список групп замен по оригинальной детали
   GET /original-part-substitutions?original_part_id=123
   ---------------------------------------------- */
router.get('/', auth, tabGuard, async (req, res) => {
  try {
    const original_part_id = toId(req.query.original_part_id)
    if (!original_part_id) {
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
    const placeholders = ids.map(() => '?').join(',')

    // 🔹 Добавили supplier_name (LEFT JOIN part_suppliers)
    const [items] = await db.execute(
      `SELECT i.substitution_id, i.supplier_part_id, i.quantity,
              sp.supplier_id,
              ps.name AS supplier_name,
              COALESCE(sp.supplier_part_number, sp.part_number) AS supplier_part_number,
              sp.description
         FROM original_part_substitution_items i
         JOIN supplier_parts sp      ON sp.id = i.supplier_part_id
         LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
        WHERE i.substitution_id IN (${placeholders})
        ORDER BY i.substitution_id, i.supplier_part_id`,
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

/* ----------------------------------------------
   Создать группу замен (mode: ANY|ALL)
   POST /original-part-substitutions
   body: { original_part_id, name?, comment?, mode? }
   ---------------------------------------------- */
router.post('/', auth, tabGuard, async (req, res) => {
  try {
    const original_part_id = toId(req.body.original_part_id)
    if (!original_part_id) {
      return res.status(400).json({ message: 'original_part_id обязателен (число)' })
    }
    const name = nz(req.body.name)
    const comment = nz(req.body.comment)
    const mode = normMode(req.body.mode) // 'ANY' | 'ALL'

    const [[op]] = await db.execute('SELECT id, cat_number FROM original_parts WHERE id=?', [original_part_id])
    if (!op) return res.status(400).json({ message: 'Оригинальная деталь не найдена' })

    const [ins] = await db.execute(
      'INSERT INTO original_part_substitutions (original_part_id, name, comment, mode) VALUES (?,?,?,?)',
      [original_part_id, name, comment, mode]
    )
    const [row] = await db.execute('SELECT * FROM original_part_substitutions WHERE id=?', [ins.insertId])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'original_part_substitutions',
      entity_id: row[0].id,
      comment: `Создана группа замен для ${op.cat_number}${name ? ` (${name})` : ''}, режим ${mode}`
    })

    res.status(201).json(row[0])
  } catch (e) {
    console.error('POST /original-part-substitutions error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ----------------------------------------------
   Обновить шапку группы (name/comment/mode)
   PUT /original-part-substitutions/:id
   body: { name?, comment?, mode? }
   ---------------------------------------------- */
router.put('/:id', auth, tabGuard, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const name = nz(req.body.name)
    const comment = nz(req.body.comment)
    const mode = req.body.mode ? normMode(req.body.mode) : null

    const [[old]] = await db.execute('SELECT * FROM original_part_substitutions WHERE id=?', [id])
    if (!old) return res.status(404).json({ message: 'Группа не найдена' })

    await db.execute(
      `UPDATE original_part_substitutions
          SET name = COALESCE(?, name),
              comment = COALESCE(?, comment),
              mode = COALESCE(?, mode)
        WHERE id = ?`,
      [name, comment, mode, id]
    )

    const [[fresh]] = await db.execute('SELECT * FROM original_part_substitutions WHERE id=?', [id])

    await logActivity({
      req,
      action: 'update',
      entity_type: 'original_part_substitutions',
      entity_id: id,
      comment: `Обновлена группа замен (name: ${old.name || '-'} → ${fresh.name || '-'}, mode: ${old.mode} → ${fresh.mode})`
    })

    res.json(fresh)
  } catch (e) {
    console.error('PUT /original-part-substitutions/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ----------------------------------------------
   Удалить группу (позиций каскадом)
   DELETE /original-part-substitutions/:id
   ---------------------------------------------- */
router.delete('/:id', auth, tabGuard, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [exists] = await db.execute('SELECT * FROM original_part_substitutions WHERE id=?', [id])
    if (!exists.length) return res.status(404).json({ message: 'Группа не найдена' })

    try {
      await db.execute('DELETE FROM original_part_substitutions WHERE id=?', [id])
    } catch (fkErr) {
      if (fkErr && fkErr.errno === 1451) {
        return res.status(409).json({ type: 'fk_constraint', message: 'Невозможно удалить: есть связанные позиции' })
      }
      throw fkErr
    }

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'original_part_substitutions',
      entity_id: id,
      comment: `Удалена группа замен (original_part_id=${exists[0].original_part_id}, name=${exists[0].name || '-'})`
    })

    res.json({ message: 'Группа удалена' })
  } catch (e) {
    console.error('DELETE /original-part-substitutions/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ----------------------------------------------
   Добавить позицию в группу
   POST /original-part-substitutions/:id/items
   body: { supplier_part_id, quantity }
   ---------------------------------------------- */
router.post('/:id/items', auth, tabGuard, async (req, res) => {
  try {
    const substitution_id = toId(req.params.id)
    const supplier_part_id = toId(req.body.supplier_part_id)
    const qRaw = req.body.quantity
    const quantity = qRaw === undefined || qRaw === null ? 1 : Number(qRaw)

    if (!substitution_id || !supplier_part_id) {
      return res.status(400).json({ message: 'substitution_id и supplier_part_id должны быть числами' })
    }
    if (!(quantity > 0)) return res.status(400).json({ message: 'quantity должен быть > 0' })

    const [[g]] = await db.execute('SELECT id FROM original_part_substitutions WHERE id=?', [substitution_id])
    const [[sp]] = await db.execute(
      'SELECT id, supplier_id, COALESCE(supplier_part_number, part_number) AS supplier_part_number FROM supplier_parts WHERE id=?',
      [supplier_part_id]
    )
    if (!g) return res.status(400).json({ message: 'Группа замен не найдена' })
    if (!sp) return res.status(400).json({ message: 'Деталь поставщика не найдена' })

    try {
      await db.execute(
        'INSERT INTO original_part_substitution_items (substitution_id, supplier_part_id, quantity) VALUES (?,?,?)',
        [substitution_id, supplier_part_id, quantity]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'Эта деталь уже есть в группе' })
      }
      if (e && e.errno === 1452) {
        return res.status(409).json({ message: 'Нарушение ссылочной целостности (неверные идентификаторы)' })
      }
      throw e
    }

    await logActivity({
      req,
      action: 'create',
      entity_type: 'original_part_substitution_items',
      entity_id: substitution_id,
      field_changed: `supplier_part:${supplier_part_id}`,
      old_value: null,
      new_value: String(quantity),
      comment: `Замены: добавлена позиция (supplier_part_number=${sp.supplier_part_number})`
    })

    // 🔹 Вернём добавленный item вместе с supplier_name — удобно для UI
    const [[withSupplier]] = await db.execute(
      `SELECT 
         i.substitution_id, i.supplier_part_id, i.quantity,
         sp.supplier_id,
         ps.name AS supplier_name,
         COALESCE(sp.supplier_part_number, sp.part_number) AS supplier_part_number,
         sp.description
       FROM original_part_substitution_items i
       JOIN supplier_parts sp      ON sp.id = i.supplier_part_id
       LEFT JOIN part_suppliers ps ON ps.id = sp.supplier_id
       WHERE i.substitution_id=? AND i.supplier_part_id=?`,
      [substitution_id, supplier_part_id]
    )

    res.status(201).json({ message: 'Позиция добавлена', item: withSupplier })
  } catch (e) {
    console.error('POST /original-part-substitutions/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ----------------------------------------------
   Изменить количество позиции
   PUT /original-part-substitutions/:id/items
   body: { supplier_part_id, quantity }
   ---------------------------------------------- */
router.put('/:id/items', auth, tabGuard, async (req, res) => {
  try {
    const substitution_id = toId(req.params.id)
    const supplier_part_id = toId(req.body.supplier_part_id)
    const quantity = Number(req.body.quantity)

    if (!substitution_id || !supplier_part_id || !(quantity > 0)) {
      return res.status(400).json({ message: 'Неверные параметры' })
    }

    const [oldRow] = await db.execute(
      'SELECT quantity FROM original_part_substitution_items WHERE substitution_id=? AND supplier_part_id=?',
      [substitution_id, supplier_part_id]
    )
    if (!oldRow.length) return res.status(404).json({ message: 'Позиция не найдена' })

    const [upd] = await db.execute(
      'UPDATE original_part_substitution_items SET quantity=? WHERE substitution_id=? AND supplier_part_id=?',
      [quantity, substitution_id, supplier_part_id]
    )
    if (upd.affectedRows === 0) return res.status(404).json({ message: 'Позиция не найдена' })

    await logActivity({
      req,
      action: 'update',
      entity_type: 'original_part_substitution_items',
      entity_id: substitution_id,
      field_changed: `supplier_part:${supplier_part_id}`,
      old_value: String(oldRow[0].quantity),
      new_value: String(quantity),
      comment: 'Замены: изменено количество'
    })

    res.json({ message: 'Количество обновлено' })
  } catch (e) {
    console.error('PUT /original-part-substitutions/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ----------------------------------------------
   Удалить позицию
   DELETE /original-part-substitutions/:id/items
   body: { supplier_part_id }
   ---------------------------------------------- */
router.delete('/:id/items', auth, tabGuard, async (req, res) => {
  try {
    const substitution_id = toId(req.params.id)
    const supplier_part_id = toId(req.body.supplier_part_id)
    if (!substitution_id || !supplier_part_id) {
      return res.status(400).json({ message: 'Неверные параметры' })
    }

    const [oldRow] = await db.execute(
      'SELECT quantity FROM original_part_substitution_items WHERE substitution_id=? AND supplier_part_id=?',
      [substitution_id, supplier_part_id]
    )
    if (!oldRow.length) return res.status(404).json({ message: 'Позиция не найдена' })

    const [del] = await db.execute(
      'DELETE FROM original_part_substitution_items WHERE substitution_id=? AND supplier_part_id=?',
      [substitution_id, supplier_part_id]
    )
    if (del.affectedRows === 0) return res.status(404).json({ message: 'Позиция не найдена' })

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'original_part_substitution_items',
      entity_id: substitution_id,
      field_changed: `supplier_part:${supplier_part_id}`,
      old_value: String(oldRow[0].quantity),
      comment: 'Замены: удалена позиция'
    })

    res.json({ message: 'Позиция удалена' })
  } catch (e) {
    console.error('DELETE /original-part-substitutions/:id/items error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ----------------------------------------------
   Развернуть группу в набор к отгрузке
   GET /original-part-substitutions/:id/resolve?qty=1
   - для mode=ALL вернёт один вариант с ВСЕМИ позициями (умноженными на qty)
   - для mode=ANY вернёт список вариантов по каждой позиции (умноженными на qty)
   ---------------------------------------------- */
router.get('/:id/resolve', auth, tabGuard, async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })
    const qty = Number(req.query.qty ?? 1)
    if (!(qty > 0)) return res.status(400).json({ message: 'qty должен быть > 0' })

    const [[g]] = await db.execute('SELECT * FROM original_part_substitutions WHERE id=?', [id])
    if (!g) return res.status(404).json({ message: 'Группа не найдена' })

    const [items] = await db.execute(
      `SELECT i.supplier_part_id, i.quantity,
              sp.supplier_id,
              COALESCE(sp.supplier_part_number, sp.part_number) AS supplier_part_number,
              sp.description
         FROM original_part_substitution_items i
         JOIN supplier_parts sp ON sp.id = i.supplier_part_id
        WHERE i.substitution_id = ?
        ORDER BY i.supplier_part_id`,
      [id]
    )

    if (!items.length) {
      return res.json({ mode: g.mode, options: [] })
    }

    if (g.mode === 'ALL') {
      // один вариант: все позиции комплекта
      return res.json({
        mode: g.mode,
        options: [
          {
            items: items.map(r => ({
              supplier_part_id: r.supplier_part_id,
              supplier_id: r.supplier_id,
              supplier_part_number: r.supplier_part_number,
              description: r.description,
              quantity: Number(r.quantity) * qty
            }))
          }
        ]
      })
    }

    // ANY: по одному варианту на каждую позицию
    const options = items.map(r => ({
      items: [{
        supplier_part_id: r.supplier_part_id,
        supplier_id: r.supplier_id,
        supplier_part_number: r.supplier_part_number,
        description: r.description,
        quantity: Number(r.quantity) * qty
      }]
    }))
    return res.json({ mode: g.mode, options })
  } catch (e) {
    console.error('GET /original-part-substitutions/:id/resolve error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
