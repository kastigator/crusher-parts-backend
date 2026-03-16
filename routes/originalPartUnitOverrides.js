const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const sqlValue = (v) => (v === undefined ? null : v)

async function resolveOemPartId(rawId) {
  const id = toId(rawId)
  if (!id) return null

  const [[oem]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [id])
  return oem ? Number(oem.id) : null
}

async function validateUnitBelongsToPart(oemPartId, unitId) {
  const [[row]] = await db.execute(
    `
    SELECT
      ceu.id,
      ceu.equipment_model_id
    FROM client_equipment_units ceu
    WHERE ceu.id = ?
      AND EXISTS (
        SELECT 1
        FROM oem_part_model_fitments f
        WHERE f.oem_part_id = ?
          AND f.equipment_model_id = ceu.equipment_model_id
      )
    `,
    [unitId, oemPartId]
  )
  return row || null
}

router.get('/:id/unit-overrides', async (req, res) => {
  try {
    const oemPartId = await resolveOemPartId(req.params.id)
    if (!oemPartId) return res.status(400).json({ message: 'Некорректная OEM деталь' })

    const [rows] = await db.execute(
      `
      SELECT
        ceu.id AS client_equipment_unit_id,
        ceu.client_id,
        ceu.equipment_model_id,
        ceu.serial_number,
        ceu.manufacture_year,
        ceu.site_name,
        ceu.internal_name,
        ceu.status AS equipment_status,
        c.company_name AS client_name,
        em.model_name,
        em.model_code,
        mf.name AS manufacturer_name,
        opuo.status AS override_status,
        opuo.replacement_oem_part_id,
        rop.part_number AS replacement_part_number,
        rop.description_ru AS replacement_description_ru,
        rop.description_en AS replacement_description_en,
        opuo.note,
        opuo.effective_from,
        opuo.effective_to,
        COUNT(DISTINCT opumo.material_id) AS unit_materials_count,
        MAX(CASE WHEN opumo.is_default = 1 THEN m.name END) AS unit_default_material_name
      FROM client_equipment_units ceu
      JOIN clients c ON c.id = ceu.client_id
      JOIN equipment_models em ON em.id = ceu.equipment_model_id
      JOIN equipment_manufacturers mf ON mf.id = em.manufacturer_id
      LEFT JOIN oem_part_unit_overrides opuo
        ON opuo.oem_part_id = ?
       AND opuo.client_equipment_unit_id = ceu.id
      LEFT JOIN oem_parts rop
        ON rop.id = opuo.replacement_oem_part_id
      LEFT JOIN oem_part_unit_material_overrides opumo
        ON opumo.oem_part_id = ?
       AND opumo.client_equipment_unit_id = ceu.id
      LEFT JOIN materials m
        ON m.id = opumo.material_id
      WHERE EXISTS (
        SELECT 1
        FROM oem_part_model_fitments f
        WHERE f.oem_part_id = ?
          AND f.equipment_model_id = ceu.equipment_model_id
      )
      GROUP BY
        ceu.id, ceu.client_id, ceu.equipment_model_id, ceu.serial_number, ceu.manufacture_year,
        ceu.site_name, ceu.internal_name, ceu.status, c.company_name, em.model_name, em.model_code,
        mf.name, opuo.status, opuo.replacement_oem_part_id, rop.part_number, rop.description_ru,
        rop.description_en, opuo.note, opuo.effective_from, opuo.effective_to
      ORDER BY c.company_name ASC, mf.name ASC, em.model_name ASC, ceu.serial_number ASC, ceu.id ASC
      `,
      [oemPartId, oemPartId, oemPartId]
    )

    res.json(rows)
  } catch (err) {
    console.error('GET /original-parts/:id/unit-overrides error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/unit-overrides/:unitId', async (req, res) => {
  try {
    const oemPartId = await resolveOemPartId(req.params.id)
    const unitId = toId(req.params.unitId)
    if (!oemPartId || !unitId) {
      return res.status(400).json({ message: 'Некорректные идентификаторы' })
    }

    const unit = await validateUnitBelongsToPart(oemPartId, unitId)
    if (!unit) {
      return res.status(409).json({
        message: 'Эта машина клиента не входит в базовую применяемость OEM детали по модели',
      })
    }

    const status = nz(req.body.status) || 'applies'
    if (!['applies', 'excluded', 'replaced', 'variant'].includes(status)) {
      return res.status(400).json({ message: 'Некорректный статус override' })
    }

    const replacement_oem_part_id =
      req.body.replacement_oem_part_id === null || req.body.replacement_oem_part_id === ''
        ? null
        : toId(req.body.replacement_oem_part_id)
    const note = nz(req.body.note)
    const effective_from = nz(req.body.effective_from)
    const effective_to = nz(req.body.effective_to)

    if (status === 'replaced' && !replacement_oem_part_id) {
      return res.status(400).json({ message: 'Для статуса replaced нужно указать replacement_oem_part_id' })
    }

    if (replacement_oem_part_id) {
      const [[replacement]] = await db.execute('SELECT id FROM oem_parts WHERE id = ?', [replacement_oem_part_id])
      if (!replacement) {
        return res.status(400).json({ message: 'Замещающая OEM деталь не найдена' })
      }
    }

    await db.execute(
      `
      INSERT INTO oem_part_unit_overrides
        (
          oem_part_id, client_equipment_unit_id, status, replacement_oem_part_id,
          note, effective_from, effective_to
        )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        replacement_oem_part_id = VALUES(replacement_oem_part_id),
        note = VALUES(note),
        effective_from = VALUES(effective_from),
        effective_to = VALUES(effective_to)
      `,
      [oemPartId, unitId, status, replacement_oem_part_id, note, effective_from, effective_to]
    )

    const [[row]] = await db.execute(
      `
      SELECT
        opuo.*,
        rop.part_number AS replacement_part_number,
        rop.description_ru AS replacement_description_ru,
        rop.description_en AS replacement_description_en
      FROM oem_part_unit_overrides opuo
      LEFT JOIN oem_parts rop ON rop.id = opuo.replacement_oem_part_id
      WHERE opuo.oem_part_id = ?
        AND opuo.client_equipment_unit_id = ?
      `,
      [oemPartId, unitId]
    )

    res.json(row)
  } catch (err) {
    console.error('PUT /original-parts/:id/unit-overrides/:unitId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id/unit-overrides/:unitId', async (req, res) => {
  try {
    const oemPartId = await resolveOemPartId(req.params.id)
    const unitId = toId(req.params.unitId)
    if (!oemPartId || !unitId) {
      return res.status(400).json({ message: 'Некорректные идентификаторы' })
    }

    await db.execute(
      'DELETE FROM oem_part_unit_overrides WHERE oem_part_id = ? AND client_equipment_unit_id = ?',
      [oemPartId, unitId]
    )
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /original-parts/:id/unit-overrides/:unitId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/unit-material-overrides/:unitId', async (req, res) => {
  try {
    const oemPartId = await resolveOemPartId(req.params.id)
    const unitId = toId(req.params.unitId)
    if (!oemPartId || !unitId) {
      return res.status(400).json({ message: 'Некорректные идентификаторы' })
    }

    const unit = await validateUnitBelongsToPart(oemPartId, unitId)
    if (!unit) {
      return res.status(409).json({
        message: 'Эта машина клиента не входит в базовую применяемость OEM детали по модели',
      })
    }

    const [rows] = await db.execute(
      `
      SELECT
        opumo.oem_part_id AS original_part_id,
        opumo.client_equipment_unit_id,
        opumo.material_id,
        opumo.is_default,
        opumo.note,
        m.name AS material_name,
        m.code AS material_code,
        m.standard AS material_standard,
        m.description AS material_description,
        opums.weight_kg AS spec_weight_kg,
        opums.length_cm AS spec_length_cm,
        opums.width_cm AS spec_width_cm,
        opums.height_cm AS spec_height_cm
      FROM oem_part_unit_material_overrides opumo
      JOIN materials m ON m.id = opumo.material_id
      LEFT JOIN oem_part_unit_material_specs opums
        ON opums.oem_part_id = opumo.oem_part_id
       AND opums.client_equipment_unit_id = opumo.client_equipment_unit_id
       AND opums.material_id = opumo.material_id
      WHERE opumo.oem_part_id = ?
        AND opumo.client_equipment_unit_id = ?
      ORDER BY opumo.is_default DESC, m.name ASC
      `,
      [oemPartId, unitId]
    )

    res.json(rows)
  } catch (err) {
    console.error('GET /original-parts/:id/unit-material-overrides/:unitId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/:id/unit-material-overrides/:unitId', async (req, res) => {
  try {
    const oemPartId = await resolveOemPartId(req.params.id)
    const unitId = toId(req.params.unitId)
    const materialId = toId(req.body.material_id)
    const isDefault = req.body.is_default ? 1 : 0
    const note = nz(req.body.note)

    if (!oemPartId || !unitId || !materialId) {
      return res.status(400).json({ message: 'Нужно выбрать OEM деталь, машину клиента и материал' })
    }

    const unit = await validateUnitBelongsToPart(oemPartId, unitId)
    if (!unit) {
      return res.status(409).json({
        message: 'Эта машина клиента не входит в базовую применяемость OEM детали по модели',
      })
    }

    const [[mat]] = await db.execute('SELECT id FROM materials WHERE id = ?', [materialId])
    if (!mat) return res.status(404).json({ message: 'Материал не найден' })

    if (isDefault) {
      await db.execute(
        `
        UPDATE oem_part_unit_material_overrides
        SET is_default = 0
        WHERE oem_part_id = ?
          AND client_equipment_unit_id = ?
        `,
        [oemPartId, unitId]
      )
    }

    await db.execute(
      `
      INSERT INTO oem_part_unit_material_overrides
        (oem_part_id, client_equipment_unit_id, material_id, is_default, note)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        is_default = VALUES(is_default),
        note = VALUES(note)
      `,
      [oemPartId, unitId, materialId, isDefault, note]
    )

    const [[row]] = await db.execute(
      `
      SELECT
        opumo.oem_part_id AS original_part_id,
        opumo.client_equipment_unit_id,
        opumo.material_id,
        opumo.is_default,
        opumo.note,
        m.name AS material_name,
        m.code AS material_code,
        m.standard AS material_standard,
        m.description AS material_description,
        opums.weight_kg AS spec_weight_kg,
        opums.length_cm AS spec_length_cm,
        opums.width_cm AS spec_width_cm,
        opums.height_cm AS spec_height_cm
      FROM oem_part_unit_material_overrides opumo
      JOIN materials m ON m.id = opumo.material_id
      LEFT JOIN oem_part_unit_material_specs opums
        ON opums.oem_part_id = opumo.oem_part_id
       AND opums.client_equipment_unit_id = opumo.client_equipment_unit_id
       AND opums.material_id = opumo.material_id
      WHERE opumo.oem_part_id = ?
        AND opumo.client_equipment_unit_id = ?
        AND opumo.material_id = ?
      `,
      [oemPartId, unitId, materialId]
    )

    res.status(201).json(row)
  } catch (err) {
    console.error('POST /original-parts/:id/unit-material-overrides/:unitId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id/unit-material-overrides/:unitId/:materialId', async (req, res) => {
  try {
    const oemPartId = await resolveOemPartId(req.params.id)
    const unitId = toId(req.params.unitId)
    const materialId = toId(req.params.materialId)
    if (!oemPartId || !unitId || !materialId) {
      return res.status(400).json({ message: 'Некорректные идентификаторы' })
    }

    await db.execute(
      `
      DELETE FROM oem_part_unit_material_overrides
      WHERE oem_part_id = ?
        AND client_equipment_unit_id = ?
        AND material_id = ?
      `,
      [oemPartId, unitId, materialId]
    )

    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /original-parts/:id/unit-material-overrides/:unitId/:materialId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id/unit-material-specs/:unitId', async (req, res) => {
  try {
    const oemPartId = await resolveOemPartId(req.params.id)
    const unitId = toId(req.params.unitId)
    const materialId = toId(req.body.material_id)
    if (!oemPartId || !unitId || !materialId) {
      return res.status(400).json({ message: 'Нужно выбрать OEM деталь, машину клиента и материал' })
    }

    const [[link]] = await db.execute(
      `
      SELECT 1
      FROM oem_part_unit_material_overrides
      WHERE oem_part_id = ?
        AND client_equipment_unit_id = ?
        AND material_id = ?
      `,
      [oemPartId, unitId, materialId]
    )
    if (!link) {
      return res.status(409).json({
        message: 'Сначала добавьте материал в machine-specific список материалов',
      })
    }

    const toNum = (v) => {
      if (v === undefined || v === null || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }

    const weight_kg = toNum(req.body.weight_kg)
    const length_cm = toNum(req.body.length_cm)
    const width_cm = toNum(req.body.width_cm)
    const height_cm = toNum(req.body.height_cm)
    const allNull = weight_kg == null && length_cm == null && width_cm == null && height_cm == null

    if (allNull) {
      await db.execute(
        `
        DELETE FROM oem_part_unit_material_specs
        WHERE oem_part_id = ?
          AND client_equipment_unit_id = ?
          AND material_id = ?
        `,
        [oemPartId, unitId, materialId]
      )
      return res.json({ success: true, deleted: true })
    }

    await db.execute(
      `
      INSERT INTO oem_part_unit_material_specs
        (
          oem_part_id, client_equipment_unit_id, material_id,
          weight_kg, length_cm, width_cm, height_cm
        )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        weight_kg = VALUES(weight_kg),
        length_cm = VALUES(length_cm),
        width_cm = VALUES(width_cm),
        height_cm = VALUES(height_cm)
      `,
      [oemPartId, unitId, materialId, weight_kg, length_cm, width_cm, height_cm]
    )

    const [[row]] = await db.execute(
      `
      SELECT *
      FROM oem_part_unit_material_specs
      WHERE oem_part_id = ?
        AND client_equipment_unit_id = ?
        AND material_id = ?
      `,
      [oemPartId, unitId, materialId]
    )
    res.json(row)
  } catch (err) {
    console.error('PUT /original-parts/:id/unit-material-specs/:unitId error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
