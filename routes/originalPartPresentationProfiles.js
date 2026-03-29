const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { createTrashEntry } = require('../utils/trashStore')
const { buildTrashPreview, MODE } = require('../utils/trashPreview')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true'

const ensureOemPart = async (rawId) => {
  const id = toId(rawId)
  if (!id) return null
  const [[row]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [id])
  return row ? Number(row.id) : null
}

router.get('/:id/presentation-profile', async (req, res) => {
  try {
    const oemPartId = await ensureOemPart(req.params.id)
    if (!oemPartId) return res.status(400).json({ message: 'Некорректная OEM деталь' })

    const [[row]] = await db.execute(
      `
      SELECT *
        FROM oem_part_presentation_profiles
       WHERE oem_part_id = ?
       LIMIT 1
      `,
      [oemPartId]
    )

    res.json(
      row || {
        id: null,
        oem_part_id: oemPartId,
        internal_part_number: null,
        internal_part_name: null,
        supplier_visible_part_number: null,
        supplier_visible_description: null,
        drawing_code: null,
        use_by_default_in_supplier_rfq: 0,
        note: null,
      }
    )
  } catch (e) {
    console.error('GET /original-parts/:id/presentation-profile error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/presentation-profile', async (req, res) => {
  try {
    const oemPartId = await ensureOemPart(req.params.id)
    if (!oemPartId) return res.status(400).json({ message: 'Некорректная OEM деталь' })

    const internalPartNumber = nz(req.body.internal_part_number)
    const internalPartName = nz(req.body.internal_part_name)
    const supplierVisiblePartNumber = nz(req.body.supplier_visible_part_number)
    const supplierVisibleDescription = nz(req.body.supplier_visible_description)
    const drawingCode = nz(req.body.drawing_code)
    const useByDefault = toBool(req.body.use_by_default_in_supplier_rfq) ? 1 : 0
    const note = nz(req.body.note)

    if (!internalPartNumber && !internalPartName && !supplierVisiblePartNumber && !supplierVisibleDescription && !drawingCode && !note && !useByDefault) {
      await db.execute('DELETE FROM oem_part_presentation_profiles WHERE oem_part_id = ?', [oemPartId])
      return res.json({
        id: null,
        oem_part_id: oemPartId,
        internal_part_number: null,
        internal_part_name: null,
        supplier_visible_part_number: null,
        supplier_visible_description: null,
        drawing_code: null,
        use_by_default_in_supplier_rfq: 0,
        note: null,
      })
    }

    await db.execute(
      `
      INSERT INTO oem_part_presentation_profiles
        (
          oem_part_id, internal_part_number, internal_part_name,
          supplier_visible_part_number, supplier_visible_description,
          drawing_code, use_by_default_in_supplier_rfq, note
        )
      VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        internal_part_number = VALUES(internal_part_number),
        internal_part_name = VALUES(internal_part_name),
        supplier_visible_part_number = VALUES(supplier_visible_part_number),
        supplier_visible_description = VALUES(supplier_visible_description),
        drawing_code = VALUES(drawing_code),
        use_by_default_in_supplier_rfq = VALUES(use_by_default_in_supplier_rfq),
        note = VALUES(note)
      `,
      [
        oemPartId,
        internalPartNumber,
        internalPartName,
        supplierVisiblePartNumber,
        supplierVisibleDescription,
        drawingCode,
        useByDefault,
        note,
      ]
    )

    const [[row]] = await db.execute(
      'SELECT * FROM oem_part_presentation_profiles WHERE oem_part_id = ? LIMIT 1',
      [oemPartId]
    )

    res.json(row)
  } catch (e) {
    console.error('PUT /original-parts/:id/presentation-profile error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id/presentation-profile', async (req, res) => {
  const conn = await db.getConnection()
  try {
    const oemPartId = await ensureOemPart(req.params.id)
    if (!oemPartId) {
      conn.release()
      return res.status(400).json({ message: 'Некорректная OEM деталь' })
    }

    const preview = await buildTrashPreview('oem_part_presentation_profiles', oemPartId)
    if (!preview) {
      conn.release()
      return res.status(404).json({ message: 'Профиль представления не найден' })
    }
    if (preview.mode !== MODE.RELATION_DELETE) {
      conn.release()
      return res.status(409).json({
        message: preview.summary?.message || 'Удаление недоступно',
        preview,
      })
    }

    await conn.beginTransaction()

    const [[row]] = await conn.execute(
      `
      SELECT opp.*, op.part_number
        FROM oem_part_presentation_profiles opp
        JOIN oem_parts op ON op.id = opp.oem_part_id
       WHERE opp.oem_part_id = ?
       LIMIT 1
       FOR UPDATE
      `,
      [oemPartId]
    )
    if (!row) {
      await conn.rollback()
      conn.release()
      return res.status(404).json({ message: 'Профиль представления не найден' })
    }

    const trashEntryId = await createTrashEntry({
      executor: conn,
      req,
      entityType: 'oem_part_presentation_profiles',
      entityId: oemPartId,
      rootEntityType: 'oem_parts',
      rootEntityId: oemPartId,
      deleteMode: 'relation_delete',
      title: `${row.part_number} / presentation profile`,
      subtitle: 'OEM presentation profile',
      snapshot: row,
    })

    await conn.execute('DELETE FROM oem_part_presentation_profiles WHERE oem_part_id = ?', [oemPartId])
    await conn.commit()
    conn.release()
    res.json({ success: true, trash_entry_id: trashEntryId, message: 'Профиль перемещён в корзину' })
  } catch (e) {
    try {
      await conn.rollback()
    } catch {}
    conn.release?.()
    console.error('DELETE /original-parts/:id/presentation-profile error:', e)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
