const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { createTrashEntry } = require('../utils/trashStore')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const linkSelect = `
  SELECT opsp.*,
         op.manufacturer_id,
         op.part_number AS oem_part_number,
         op.description_ru AS oem_description_ru,
         op.description_en AS oem_description_en,
         sp.class_id,
         sp.display_name,
         sp.designation,
         sp.description_ru AS standard_description_ru,
         sp.description_en AS standard_description_en,
         spc.name AS class_name
    FROM oem_part_standard_parts opsp
    JOIN oem_parts op ON op.id = opsp.oem_part_id
    JOIN standard_parts sp ON sp.id = opsp.standard_part_id
    LEFT JOIN standard_part_classes spc ON spc.id = sp.class_id
`

router.get('/', async (req, res) => {
  try {
    const oemPartId = req.query.oem_part_id !== undefined ? toId(req.query.oem_part_id) : null
    const standardPartId =
      req.query.standard_part_id !== undefined ? toId(req.query.standard_part_id) : null

    if (req.query.oem_part_id !== undefined && !oemPartId) {
      return res.status(400).json({ message: 'Некорректный oem_part_id' })
    }
    if (req.query.standard_part_id !== undefined && !standardPartId) {
      return res.status(400).json({ message: 'Некорректный standard_part_id' })
    }

    const where = []
    const params = []
    let sql = linkSelect
    if (oemPartId) {
      where.push('opsp.oem_part_id = ?')
      params.push(oemPartId)
    }
    if (standardPartId) {
      where.push('opsp.standard_part_id = ?')
      params.push(standardPartId)
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY opsp.is_primary DESC, sp.display_name ASC, sp.id ASC'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /oem-part-standard-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  res.status(410).json({
    message:
      'Ручное создание связи из OEM карточки отключено. Создавайте OEM-представление из каталога стандартных деталей.',
  })
})

router.put('/:oemPartId/:standardPartId', async (req, res) => {
  res.status(410).json({
    message:
      'Редактирование связи из OEM карточки отключено. Управляйте связями из каталога стандартных деталей.',
  })
})

router.delete('/:oemPartId/:standardPartId', async (req, res) => {
  const oemPartId = toId(req.params.oemPartId)
  const standardPartId = toId(req.params.standardPartId)
  if (!oemPartId || !standardPartId) {
    return res.status(400).json({ message: 'Некорректные идентификаторы связи' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[row]] = await conn.execute(
      `
      ${linkSelect}
      WHERE opsp.oem_part_id = ?
        AND opsp.standard_part_id = ?
      FOR UPDATE
      `,
      [oemPartId, standardPartId]
    )
    if (!row) {
      await conn.rollback()
      return res.status(404).json({ message: 'Связь не найдена' })
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'oem_part_standard_parts',
      entityId: oemPartId,
      rootEntityType: 'oem_parts',
      rootEntityId: oemPartId,
      deleteMode: 'relation_delete',
      title: `${row.oem_part_number} / ${row.display_name || row.designation || `Standard part #${standardPartId}`}`,
      subtitle: 'OEM to standard part link',
      snapshot: row,
      context: { standard_part_id: standardPartId },
    })

    const [del] = await conn.execute(
      'DELETE FROM oem_part_standard_parts WHERE oem_part_id = ? AND standard_part_id = ?',
      [oemPartId, standardPartId]
    )
    if (!del.affectedRows) {
      await conn.rollback()
      return res.status(404).json({ message: 'Связь не найдена' })
    }

    await conn.commit()
    res.json({ success: true, trash_entry_id: trashEntryId })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('DELETE /oem-part-standard-parts/:oemPartId/:standardPartId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

module.exports = router
