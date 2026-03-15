const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const toBool = (v) => v === true || v === '1' || v === 1 || v === 'true'

const sqlValue = (v) => (v === undefined ? null : v)

const linkSelect = `
  SELECT opsp.*,
         op.manufacturer_id,
         op.part_number AS oem_part_number,
         op.description_ru AS oem_description_ru,
         op.description_en AS oem_description_en,
         sp.part_type,
         sp.designation,
         sp.standard_system,
         sp.description_ru AS standard_description_ru,
         sp.description_en AS standard_description_en
    FROM oem_part_standard_parts opsp
    JOIN oem_parts op ON op.id = opsp.oem_part_id
    JOIN standard_parts sp ON sp.id = opsp.standard_part_id
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
    sql += ' ORDER BY opsp.is_primary DESC, sp.part_type ASC, sp.designation ASC'

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /oem-part-standard-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const oem_part_id = toId(req.body.oem_part_id)
    const standard_part_id = toId(req.body.standard_part_id)
    const is_primary = toBool(req.body.is_primary) ? 1 : 0
    const note = nz(req.body.note)

    if (!oem_part_id) return res.status(400).json({ message: 'oem_part_id обязателен' })
    if (!standard_part_id) {
      return res.status(400).json({ message: 'standard_part_id обязателен' })
    }

    const [[oem]] = await conn.execute('SELECT id FROM oem_parts WHERE id = ?', [oem_part_id])
    if (!oem) return res.status(400).json({ message: 'OEM деталь не найдена' })

    const [[standard]] = await conn.execute('SELECT id FROM standard_parts WHERE id = ?', [standard_part_id])
    if (!standard) return res.status(400).json({ message: 'Стандартная деталь не найдена' })

    await conn.beginTransaction()
    if (is_primary) {
      await conn.execute('UPDATE oem_part_standard_parts SET is_primary = 0 WHERE oem_part_id = ?', [
        oem_part_id,
      ])
    }
    await conn.execute(
      `
      INSERT INTO oem_part_standard_parts (oem_part_id, standard_part_id, is_primary, note)
      VALUES (?, ?, ?, ?)
      `,
      [oem_part_id, standard_part_id, is_primary, note]
    )
    await conn.commit()

    const [[created]] = await db.execute(
      `${linkSelect} WHERE opsp.oem_part_id = ? AND opsp.standard_part_id = ?`,
      [oem_part_id, standard_part_id]
    )
    await logActivity({
      req,
      action: 'create',
      entity_type: 'oem_part_standard_parts',
      entity_id: oem_part_id,
      comment: 'Создана связь OEM детали со стандартной деталью',
    })

    res.status(201).json(created)
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Такая связь уже существует' })
    }
    console.error('POST /oem-part-standard-parts error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.put('/:oemPartId/:standardPartId', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const oemPartId = toId(req.params.oemPartId)
    const standardPartId = toId(req.params.standardPartId)
    if (!oemPartId || !standardPartId) {
      return res.status(400).json({ message: 'Некорректные идентификаторы связи' })
    }

    const [[before]] = await conn.execute(
      'SELECT * FROM oem_part_standard_parts WHERE oem_part_id = ? AND standard_part_id = ?',
      [oemPartId, standardPartId]
    )
    if (!before) return res.status(404).json({ message: 'Связь не найдена' })

    const is_primary = req.body.is_primary !== undefined ? (toBool(req.body.is_primary) ? 1 : 0) : undefined
    const note = req.body.note !== undefined ? nz(req.body.note) : undefined

    await conn.beginTransaction()
    if (is_primary === 1) {
      await conn.execute('UPDATE oem_part_standard_parts SET is_primary = 0 WHERE oem_part_id = ?', [
        oemPartId,
      ])
    }
    await conn.execute(
      `
      UPDATE oem_part_standard_parts
         SET is_primary = COALESCE(?, is_primary),
             note = COALESCE(?, note)
       WHERE oem_part_id = ? AND standard_part_id = ?
      `,
      [sqlValue(is_primary), sqlValue(note), oemPartId, standardPartId]
    )
    await conn.commit()

    const [[after]] = await db.execute(
      'SELECT * FROM oem_part_standard_parts WHERE oem_part_id = ? AND standard_part_id = ?',
      [oemPartId, standardPartId]
    )
    await logFieldDiffs({
      req,
      entity_type: 'oem_part_standard_parts',
      entity_id: oemPartId,
      oldData: before,
      newData: after,
    })

    const [[fresh]] = await db.execute(
      `${linkSelect} WHERE opsp.oem_part_id = ? AND opsp.standard_part_id = ?`,
      [oemPartId, standardPartId]
    )
    res.json(fresh)
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('PUT /oem-part-standard-parts/:oemPartId/:standardPartId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    conn.release()
  }
})

router.delete('/:oemPartId/:standardPartId', async (req, res) => {
  try {
    const oemPartId = toId(req.params.oemPartId)
    const standardPartId = toId(req.params.standardPartId)
    if (!oemPartId || !standardPartId) {
      return res.status(400).json({ message: 'Некорректные идентификаторы связи' })
    }

    const [[before]] = await db.execute(
      'SELECT * FROM oem_part_standard_parts WHERE oem_part_id = ? AND standard_part_id = ?',
      [oemPartId, standardPartId]
    )
    if (!before) return res.status(404).json({ message: 'Связь не найдена' })

    await db.execute(
      'DELETE FROM oem_part_standard_parts WHERE oem_part_id = ? AND standard_part_id = ?',
      [oemPartId, standardPartId]
    )

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'oem_part_standard_parts',
      entity_id: oemPartId,
      comment: 'Удалена связь OEM детали со стандартной деталью',
    })

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /oem-part-standard-parts/:oemPartId/:standardPartId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
