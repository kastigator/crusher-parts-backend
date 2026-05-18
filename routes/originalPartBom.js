// routes/originalPartBom.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const { createTrashEntry, createTrashEntryItem } = require('../utils/trashStore')

/**
 * ВНИМАНИЕ:
 *  - Авторизация (authMiddleware) и requireTabAccess('/original-parts')
 *    навешиваются снаружи в routerIndex.js.
 *  - Здесь только логика BOM для оригинальных деталей.
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
const toQty = (v, def = 1) => {
  if (v === '' || v === undefined || v === null) return def
  const n = Number(String(v).replace(',', '.'))
  return Number.isInteger(n) && n > 0 ? n : NaN
}
const normLimit = (v, def = 500, max = 5000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}
const normOffset = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

async function resolveOemPartId(rawId) {
  const id = toId(rawId)
  if (!id) return null

  const [[oem]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [id])
  return oem ? Number(oem.id) : null
}

// запрет циклов: проверяем достижимость child -> ... -> parent
async function wouldCreateCycle(parentId, childId, equipmentModelId = null) {
  if (parentId === childId) return true
  const modelId = toId(equipmentModelId)
  const [rows] = await db.execute(
    `
    WITH RECURSIVE chain AS (
      SELECT child_oem_part_id AS node_id
        FROM oem_part_model_bom
       WHERE parent_oem_part_id = ?
         AND (? IS NULL OR equipment_model_id = ?)
      UNION ALL
      SELECT b.child_oem_part_id
        FROM oem_part_model_bom b
        JOIN chain c ON b.parent_oem_part_id = c.node_id
       WHERE (? IS NULL OR b.equipment_model_id = ?)
    )
    SELECT 1 FROM chain WHERE node_id = ? LIMIT 1
    `,
    // стартуем от child (как от "родителя"), ища среди его потомков parent
    [childId, modelId, modelId, modelId, modelId, parentId]
  )
  return rows.length > 0
}

async function getPart(id, equipmentModelId = null) {
  const oemPartId = await resolveOemPartId(id)
  if (!oemPartId) return null
  const modelId = toId(equipmentModelId)

  const [[row]] = await db.execute(
    `
    SELECT
      p.id,
      p.part_number AS cat_number,
      COALESCE(selected_fit.equipment_model_id, fit.equipment_model_id) AS equipment_model_id
    FROM oem_parts p
    LEFT JOIN (
      SELECT oem_part_id, MIN(equipment_model_id) AS equipment_model_id
      FROM oem_part_model_fitments
      GROUP BY oem_part_id
    ) fit ON fit.oem_part_id = p.id
    LEFT JOIN oem_part_model_fitments selected_fit
      ON selected_fit.oem_part_id = p.id
     AND selected_fit.equipment_model_id = ?
    WHERE p.id = ?
    `,
    [modelId, oemPartId]
  )
  return row || null
}

async function resolveChildIdByCatNumber(cat, modelId) {
  const [rows] = await db.execute(
    `
    SELECT p.id
    FROM oem_parts p
    JOIN oem_part_model_fitments f ON f.oem_part_id = p.id
    WHERE f.equipment_model_id = ? AND p.part_number = ?
    LIMIT 1
    `,
    [modelId, String(cat).trim()]
  )
  return rows[0]?.id || null
}

/* ---------------------------------------------------------------
   GET /original-part-bom?parent_id=123
   Состав конкретной сборки (с пагинацией при больших BOM)
---------------------------------------------------------------- */
router.get('/', async (req, res) => {
  try {
    const parent_id = toId(req.query.parent_id)
    const requestedModelId = toId(req.query.equipment_model_id)
    if (!parent_id) {
      return res
        .status(400)
        .json({ message: 'Нужно выбрать родительскую деталь' })
    }

    const limit = normLimit(req.query.limit, 1000, 5000)
    const offset = normOffset(req.query.offset)

    // ⚠️ LIMIT / OFFSET подставляем числом, без плейсхолдеров
    const sql = `
      SELECT
        b.parent_oem_part_id AS parent_part_id,
        b.child_oem_part_id AS child_part_id,
        b.quantity,
        c.part_number      AS child_cat_number,
        c.description_en  AS child_description_en,
        c.description_ru  AS child_description_ru
      FROM oem_part_model_bom b
      JOIN oem_parts c ON c.id = b.child_oem_part_id
      WHERE b.parent_oem_part_id = ?
        ${requestedModelId ? 'AND b.equipment_model_id = ?' : ''}
      ORDER BY c.part_number
      LIMIT ${limit} OFFSET ${offset}
    `

    const [rows] = await db.execute(sql, requestedModelId ? [parent_id, requestedModelId] : [parent_id])
    res.json(rows)
  } catch (e) {
    console.error('GET /original-part-bom error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ---------------------------------------------------------------
   POST /original-part-bom
   body: { parent_part_id, child_part_id, quantity }
---------------------------------------------------------------- */
router.post('/', async (req, res) => {
  try {
    const parent_part_id = toId(req.body.parent_part_id)
    const child_part_id = toId(req.body.child_part_id)
    const quantity = toQty(req.body.quantity, 1)

    if (!parent_part_id || !child_part_id) {
      return res.status(400).json({
        message:
          'parent_part_id и child_part_id обязательны и должны быть числами',
      })
    }
    if (!(quantity > 0)) {
      return res
        .status(400)
        .json({ message: 'quantity должен быть положительным целым числом' })
    }
    if (parent_part_id === child_part_id) {
      return res
        .status(400)
        .json({ message: 'Нельзя добавить деталь саму в себя' })
    }

    const requestedModelId = toId(req.body.equipment_model_id ?? req.query.equipment_model_id)
    const parent = await getPart(parent_part_id, requestedModelId)
    const child = await getPart(child_part_id, parent?.equipment_model_id || requestedModelId)
    if (!parent)
      return res.status(400).json({ message: 'Родительская деталь не найдена' })
    if (!child)
      return res.status(400).json({ message: 'Дочерняя деталь не найдена' })

    if (await wouldCreateCycle(parent_part_id, child_part_id, parent.equipment_model_id)) {
      return res
        .status(409)
        .json({ message: 'Добавление создаст цикл в BOM' })
    }

    if (parent.equipment_model_id !== child.equipment_model_id) {
      return res.status(409).json({
        message:
          'Родитель и ребёнок должны принадлежать одной модели оборудования',
      })
    }

    try {
      await db.execute(
        `INSERT INTO oem_part_model_bom (parent_oem_part_id, equipment_model_id, child_oem_part_id, quantity)
         VALUES (?,?,?,?)`,
        [parent_part_id, parent.equipment_model_id, child_part_id, quantity]
      )
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res
          .status(409)
          .json({ message: 'Такая строка BOM уже существует' })
      }
      if (e && e.errno === 1452) {
        return res.status(409).json({
          message:
            'Нарушение ссылочной целостности (проверьте модель/идентификаторы)',
        })
      }
      throw e
    }

    await logActivity({
      req,
      action: 'create',
      entity_type: 'oem_part_model_bom',
      entity_id: parent_part_id,
      field_changed: `child:${child_part_id}`,
      old_value: null,
      new_value: String(quantity),
      comment: `BOM: добавлена позиция`,
    })

    res.status(201).json({ message: 'Строка BOM добавлена' })
  } catch (e) {
    console.error('POST /original-part-bom error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ---------------------------------------------------------------
   POST /original-part-bom/bulk
   body: { parent_part_id, items: [{ child_part_id?|cat_number?, qty|quantity?, note? }, ...] }
---------------------------------------------------------------- */
router.post('/bulk', async (req, res) => {
  try {
    const parentId = toId(req.body?.parent_part_id)
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!parentId)
      return res.status(400).json({ message: 'Нужно выбрать родительскую деталь' })
    if (!items.length)
      return res.status(400).json({ message: 'items пуст' })

    // защита от слишком больших пачек
    const MAX_ITEMS = 5000
    if (items.length > MAX_ITEMS) {
      return res
        .status(413)
        .json({ message: `Слишком большая пачка (>${MAX_ITEMS})` })
    }

    const requestedModelId = toId(req.body?.equipment_model_id ?? req.query.equipment_model_id)
    const parent = await getPart(parentId, requestedModelId)
    if (!parent)
      return res
        .status(400)
        .json({ message: 'Родительская деталь не найдена' })
    const modelId = parent.equipment_model_id

    const prepared = []
    const errors = []

    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {}
      let childId = toId(it.child_part_id)

      if (!childId && it.cat_number) {
        childId = await resolveChildIdByCatNumber(it.cat_number, modelId)
        if (!childId) {
          errors.push({
            index: i,
            reason: 'cat_number не найден в этой модели',
            payload: it,
          })
          continue
        }
      }

      if (!childId) {
        errors.push({
          index: i,
          reason: 'не указан child_part_id или cat_number',
          payload: it,
        })
        continue
      }
      if (childId === parentId) {
        errors.push({
          index: i,
          reason: 'нельзя добавить деталь саму в себя',
          payload: it,
        })
        continue
      }

      const child = await getPart(childId, modelId)
      if (!child) {
        errors.push({
          index: i,
          reason: 'child_part_id не существует',
          payload: it,
        })
        continue
      }
      if (child.equipment_model_id !== modelId) {
        errors.push({
          index: i,
          reason: 'ребёнок в другой модели',
          payload: it,
        })
        continue
      }

      if (await wouldCreateCycle(parentId, childId, modelId)) {
        errors.push({ index: i, reason: 'цикл в BOM', payload: it })
        continue
      }

      const qty = toQty(it.qty ?? it.quantity ?? 1, 1)
      if (!(qty > 0)) {
        errors.push({
          index: i,
          reason: 'quantity должен быть положительным целым числом',
          payload: it,
        })
        continue
      }
      prepared.push([parentId, modelId, childId, qty])
    }

    if (!prepared.length) {
      return res.status(400).json({
        message: 'Нет валидных элементов для вставки',
        errors,
      })
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      const valuesSql = prepared.map(() => '(?,?,?,?)').join(', ')
      const flat = prepared.flat()

      await conn.execute(
        `
        INSERT INTO oem_part_model_bom (parent_oem_part_id, equipment_model_id, child_oem_part_id, quantity)
        VALUES ${valuesSql}
        ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)
        `,
        flat
      )

      await logActivity({
        req,
        action: 'create',
        entity_type: 'oem_part_model_bom',
        entity_id: parentId,
        comment: `BULK: добавлено/обновлено позиций: ${prepared.length}`,
      })

      await conn.commit()
    } catch (e) {
      try {
        await conn.rollback()
      } catch (_) {
        // ignore rollback error and rethrow primary failure
      }
      throw e
    } finally {
      conn.release()
    }

    res.json({ inserted: prepared.length, errors })
  } catch (e) {
    console.error('POST /original-part-bom/bulk error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ---------------------------------------------------------------
   PUT /original-part-bom — обновить количество
   body: { parent_part_id, child_part_id, quantity }
---------------------------------------------------------------- */
router.put('/', async (req, res) => {
  try {
    const parent_part_id = toId(req.body.parent_part_id)
    const child_part_id = toId(req.body.child_part_id)
    const quantity = toQty(req.body.quantity, NaN)

    if (!parent_part_id || !child_part_id) {
      return res.status(400).json({
        message:
          'parent_part_id и child_part_id обязательны и должны быть числами',
      })
    }
    if (!(quantity > 0)) {
      return res
        .status(400)
        .json({ message: 'quantity должен быть положительным целым числом' })
    }

    const requestedModelId = toId(req.body.equipment_model_id ?? req.query.equipment_model_id)
    const parent = await getPart(parent_part_id, requestedModelId)
    if (!parent)
      return res.status(400).json({ message: 'Родительская деталь не найдена' })

    const [oldRow] = await db.execute(
      'SELECT quantity FROM oem_part_model_bom WHERE parent_oem_part_id=? AND child_oem_part_id=? AND equipment_model_id=?',
      [parent_part_id, child_part_id, parent.equipment_model_id]
    )
    if (!oldRow.length)
      return res.status(404).json({ message: 'Строка BOM не найдена' })

    const [upd] = await db.execute(
      'UPDATE oem_part_model_bom SET quantity=? WHERE parent_oem_part_id=? AND child_oem_part_id=? AND equipment_model_id=?',
      [quantity, parent_part_id, child_part_id, parent.equipment_model_id]
    )
    if (upd.affectedRows === 0)
      return res.status(404).json({ message: 'Строка BOM не найдена' })

    await logActivity({
      req,
      action: 'update',
      entity_type: 'oem_part_model_bom',
      entity_id: parent_part_id,
      field_changed: `child:${child_part_id}`,
      old_value: String(oldRow[0].quantity),
      new_value: String(quantity),
      comment: 'BOM: изменение количества',
    })

    res.json({ message: 'Количество обновлено' })
  } catch (e) {
    console.error('PUT /original-part-bom error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ---------------------------------------------------------------
   DELETE /original-part-bom/bulk — массово удалить строки BOM
   body: { items: [{ parent_part_id, child_part_id }, ...] }
---------------------------------------------------------------- */
router.delete('/bulk', async (req, res) => {
  let conn
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!items.length) {
      return res.status(400).json({ message: 'Не выбраны строки BOM' })
    }

    const MAX_ITEMS = 500
    if (items.length > MAX_ITEMS) {
      return res
        .status(413)
        .json({ message: `Слишком большая пачка (>${MAX_ITEMS})` })
    }

    const requested = []
    const seen = new Set()
    for (const raw of items) {
      const parentId = toId(raw?.parent_part_id)
      const childId = toId(raw?.child_part_id)
      if (!parentId || !childId) continue
      const modelId = toId(raw?.equipment_model_id ?? req.body?.equipment_model_id ?? req.query.equipment_model_id)
      const key = `${parentId}:${childId}:${modelId || 'auto'}`
      if (seen.has(key)) continue
      seen.add(key)
      requested.push({ parentId, childId, modelId })
    }

    if (!requested.length) {
      return res.status(400).json({ message: 'Нет валидных строк BOM для удаления' })
    }

    conn = await db.getConnection()
    await conn.beginTransaction()

    const rowsToDelete = []
    const skipped = []
    for (const item of requested) {
      const parent = await getPart(item.parentId, item.modelId)
      if (!parent?.equipment_model_id) {
        skipped.push({
          parent_part_id: item.parentId,
          child_part_id: item.childId,
          reason: 'Модель BOM не найдена',
        })
        continue
      }
      const [rows] = await conn.execute(
        `
        SELECT b.*,
               p.part_number AS parent_part_number,
               c.part_number AS child_part_number
          FROM oem_part_model_bom b
          JOIN oem_parts p ON p.id = b.parent_oem_part_id
          JOIN oem_parts c ON c.id = b.child_oem_part_id
         WHERE b.parent_oem_part_id = ?
           AND b.child_oem_part_id = ?
           AND b.equipment_model_id = ?
         FOR UPDATE
        `,
        [item.parentId, item.childId, parent.equipment_model_id]
      )
      if (!rows.length) {
        skipped.push({
          parent_part_id: item.parentId,
          child_part_id: item.childId,
          reason: 'Строка BOM не найдена',
        })
        continue
      }
      rowsToDelete.push(rows[0])
    }

    if (!rowsToDelete.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Выбранные строки BOM не найдены', skipped })
    }

    const rootParentId = Number(rowsToDelete[0].parent_oem_part_id)
    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'oem_part_model_bom',
      entityId: rootParentId,
      rootEntityType: 'oem_parts',
      rootEntityId: rootParentId,
      deleteMode: 'relation_delete',
      title: `Массовое удаление BOM: ${rowsToDelete.length} строк`,
      subtitle: 'BOM rows bulk delete',
      snapshot: { rows: rowsToDelete },
      context: {
        deleted_count: rowsToDelete.length,
        skipped_count: skipped.length,
        skipped,
      },
    })

    let sortOrder = 0
    for (const row of rowsToDelete) {
      await createTrashEntryItem({
        executor: conn,
        trashEntryId,
        itemType: 'oem_part_model_bom',
        itemId: Number(row.parent_oem_part_id),
        itemRole: 'bom_row',
        title: `${row.parent_part_number || row.parent_oem_part_id} -> ${row.child_part_number || row.child_oem_part_id}`,
        snapshot: row,
        sortOrder: sortOrder++,
      })
      await conn.execute(
        `
        DELETE FROM oem_part_model_bom
         WHERE parent_oem_part_id = ?
           AND child_oem_part_id = ?
           AND equipment_model_id = ?
        `,
        [row.parent_oem_part_id, row.child_oem_part_id, row.equipment_model_id]
      )
    }

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'oem_part_model_bom',
      entity_id: rootParentId,
      old_value: String(trashEntryId),
      comment: `BOM: массовое удаление позиций (${rowsToDelete.length})`,
    })

    await conn.commit()
    res.json({
      message: 'Строки BOM удалены',
      deleted: rowsToDelete.length,
      skipped,
      trash_entry_id: trashEntryId,
    })
  } catch (e) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('DELETE /original-part-bom/bulk error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    if (conn) conn.release()
  }
})

/* ---------------------------------------------------------------
   DELETE /original-part-bom — удалить строку
   body: { parent_part_id, child_part_id }
---------------------------------------------------------------- */
router.delete('/', async (req, res) => {
  let conn
  try {
    const parent_part_id = toId(
      req.body.parent_part_id ?? req.query.parent_part_id
    )
    const child_part_id = toId(
      req.body.child_part_id ?? req.query.child_part_id
    )
    if (!parent_part_id || !child_part_id) {
      return res.status(400).json({
        message:
          'parent_part_id и child_part_id обязательны и должны быть числами',
      })
    }

    const requestedModelId = toId(req.body.equipment_model_id ?? req.query.equipment_model_id)
    const parent = await getPart(parent_part_id, requestedModelId)
    if (!parent)
      return res.status(400).json({ message: 'Родительская деталь не найдена' })

    conn = await db.getConnection()
    await conn.beginTransaction()

    const [oldRow] = await conn.execute(
      'SELECT * FROM oem_part_model_bom WHERE parent_oem_part_id=? AND child_oem_part_id=? AND equipment_model_id=?',
      [parent_part_id, child_part_id, parent.equipment_model_id]
    )
    if (!oldRow.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Строка BOM не найдена' })
    }

    const [[names]] = await conn.execute(
      `
      SELECT p.part_number AS parent_part_number, c.part_number AS child_part_number
      FROM oem_parts p
      JOIN oem_parts c ON c.id = ?
      WHERE p.id = ?
      `,
      [child_part_id, parent_part_id]
    )

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'oem_part_model_bom',
      entityId: parent_part_id,
      rootEntityType: 'oem_parts',
      rootEntityId: parent_part_id,
      deleteMode: 'relation_delete',
      title: `${names?.parent_part_number || parent_part_id} -> ${names?.child_part_number || child_part_id}`,
      subtitle: 'BOM row',
      snapshot: oldRow[0],
      context: {
        child_part_id,
      },
    })

    const [del] = await conn.execute(
      'DELETE FROM oem_part_model_bom WHERE parent_oem_part_id=? AND child_oem_part_id=? AND equipment_model_id=?',
      [parent_part_id, child_part_id, parent.equipment_model_id]
    )
    if (del.affectedRows === 0) {
      await conn.rollback()
      return res.status(404).json({ message: 'Строка BOM не найдена' })
    }

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'oem_part_model_bom',
      entity_id: parent_part_id,
      field_changed: `child:${child_part_id}`,
      old_value: String(trashEntryId),
      comment: 'BOM: удаление позиции',
    })

    await conn.commit()
    res.json({ message: 'Строка BOM удалена', trash_entry_id: trashEntryId })
  } catch (e) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('DELETE /original-part-bom error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    if (conn) conn.release()
  }
})

/* ---------------------------------------------------------------
   GET /original-part-bom/used-in?child_id=ID — где используется
---------------------------------------------------------------- */
router.get('/used-in', async (req, res) => {
  try {
    const child_id = toId(req.query.child_id)
    if (!child_id) {
      return res
        .status(400)
        .json({ message: 'Нужно выбрать дочернюю деталь' })
    }

    const requestedModelId = toId(req.query.equipment_model_id)
    const [[child]] = await db.execute(
      `
      SELECT
        p.id,
        fit.equipment_model_id
      FROM oem_parts p
      LEFT JOIN (
        SELECT oem_part_id, MIN(equipment_model_id) AS equipment_model_id
        FROM oem_part_model_fitments
        GROUP BY oem_part_id
      ) fit ON fit.oem_part_id = p.id
      WHERE p.id = ?
      `,
      [child_id]
    )
    if (!child) return res.status(404).json({ message: 'Деталь не найдена' })

    const [rows] = await db.execute(
      `
      SELECT
        b.parent_oem_part_id  AS parent_id,
        b.child_oem_part_id   AS child_id,
        b.quantity,
        p.part_number         AS parent_cat_number,
        p.description_en      AS parent_description_en,
        p.description_ru      AS parent_description_ru
      FROM oem_part_model_bom b
      JOIN oem_parts p ON p.id = b.parent_oem_part_id
      WHERE b.child_oem_part_id = ?
        AND b.equipment_model_id = ?
      ORDER BY p.part_number
      `,
      [child_id, requestedModelId || child.equipment_model_id]
    )

    res.json(rows)
  } catch (e) {
    console.error('GET /original-part-bom/used-in error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ---------------------------------------------------------------
   GET /original-part-bom/tree/:id — дерево вниз (MySQL 8 CTE)
---------------------------------------------------------------- */
router.get('/tree/:id', async (req, res) => {
  try {
    const rootId = toId(req.params.id)
    if (!rootId) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const requestedModelId = toId(req.query.equipment_model_id)
    const params = requestedModelId ? [rootId, requestedModelId] : [rootId, rootId]
    const modelCondition = requestedModelId
      ? 'ob.equipment_model_id = ?'
      : `ob.equipment_model_id = (
           SELECT MIN(f.equipment_model_id)
           FROM oem_part_model_fitments f
           WHERE f.oem_part_id = ?
         )`

    const [rows] = await db.execute(
      `
      WITH RECURSIVE bom AS (
        SELECT p.id AS node_id,
               CAST(NULL AS UNSIGNED) AS parent_part_id,
               CAST(NULL AS UNSIGNED) AS edge_qty,
               p.part_number AS cat_number, p.description_en, p.description_ru,
               0 AS level, CAST(p.id AS CHAR(1024)) AS path, CAST(1 AS DECIMAL(18,0)) AS mult_qty
          FROM oem_parts p
         WHERE p.id = ?

        UNION ALL

        SELECT c.id,
               CAST(b.node_id AS UNSIGNED) AS parent_part_id,
               CAST(ob.quantity AS UNSIGNED) AS edge_qty,
               c.part_number AS cat_number, c.description_en, c.description_ru,
               b.level + 1, CONCAT(b.path, '>', c.id), b.mult_qty * CAST(ob.quantity AS UNSIGNED)
          FROM bom b
          JOIN oem_part_model_bom ob ON ob.parent_oem_part_id = b.node_id
          JOIN oem_parts c           ON c.id = ob.child_oem_part_id
         WHERE ${modelCondition}
      )
      SELECT * FROM bom ORDER BY level, path
      `,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /original-part-bom/tree/:id error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
