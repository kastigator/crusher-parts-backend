const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const clampLimit = (value, fallback = 20, max = 100) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.trunc(n), max)
}

router.get('/summary', async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit)

    const [[counts]] = await db.execute(
      `
      SELECT
        (SELECT COUNT(*) FROM equipment_models WHERE classifier_node_id IS NULL) AS equipment_models_without_classifier,
        (
          SELECT COUNT(*)
            FROM oem_parts op
            LEFT JOIN oem_part_standard_parts link ON link.oem_part_id = op.id
           WHERE link.oem_part_id IS NULL
        ) AS oem_without_standard_link,
        (
          SELECT COUNT(*)
            FROM supplier_parts sp
            LEFT JOIN supplier_part_standard_parts link ON link.supplier_part_id = sp.id
           WHERE link.supplier_part_id IS NULL
        ) AS supplier_parts_without_standard_link,
        (
          SELECT COUNT(*)
            FROM oem_parts op
            LEFT JOIN (
              SELECT oem_part_id,
                     MAX(weight_kg IS NOT NULL) AS has_weight,
                     MAX(length_cm IS NOT NULL AND width_cm IS NOT NULL AND height_cm IS NOT NULL) AS has_dimensions
                FROM oem_part_model_fitments
               GROUP BY oem_part_id
            ) fit ON fit.oem_part_id = op.id
           WHERE COALESCE(fit.has_weight, 0) = 0
              OR COALESCE(fit.has_dimensions, 0) = 0
        ) AS oem_missing_logistics,
        (
          SELECT COUNT(*)
            FROM supplier_parts sp
           WHERE sp.weight_kg IS NULL
              OR sp.length_cm IS NULL
              OR sp.width_cm IS NULL
              OR sp.height_cm IS NULL
        ) AS supplier_parts_missing_logistics,
        (
          SELECT COUNT(*)
            FROM standard_part_classes c
            LEFT JOIN standard_part_class_fields f ON f.class_id = c.id
           WHERE f.id IS NULL
        ) AS standard_classes_without_fields,
        (
          SELECT COUNT(*)
            FROM standard_parts sp
            LEFT JOIN oem_part_standard_parts ol ON ol.standard_part_id = sp.id
            LEFT JOIN supplier_part_standard_parts sl ON sl.standard_part_id = sp.id
           WHERE ol.standard_part_id IS NULL
             AND sl.standard_part_id IS NULL
        ) AS standard_parts_without_links
      `
    )

    const [modelsWithoutClassifier] = await db.execute(
      `
      SELECT em.id,
             em.model_name,
             em.model_code,
             m.id AS manufacturer_id,
             m.name AS manufacturer_name,
             COUNT(DISTINCT f.oem_part_id) AS oem_parts_count,
             COUNT(DISTINCT ceu.id) AS client_units_count
        FROM equipment_models em
        JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
        LEFT JOIN oem_part_model_fitments f ON f.equipment_model_id = em.id
        LEFT JOIN client_equipment_units ceu ON ceu.equipment_model_id = em.id
       WHERE em.classifier_node_id IS NULL
       GROUP BY em.id, em.model_name, em.model_code, m.id, m.name
       ORDER BY oem_parts_count DESC, client_units_count DESC, m.name, em.model_name
       LIMIT ${limit}
      `
    )

    const [oemWithoutStandardLink] = await db.execute(
      `
      SELECT op.id,
             op.part_number,
             op.description_ru,
             op.description_en,
             m.name AS manufacturer_name,
             COUNT(DISTINCT f.equipment_model_id) AS fitments_count,
             COUNT(DISTINCT sp_link.supplier_part_id) AS supplier_links_count
        FROM oem_parts op
        JOIN equipment_manufacturers m ON m.id = op.manufacturer_id
        LEFT JOIN oem_part_standard_parts std_link ON std_link.oem_part_id = op.id
        LEFT JOIN oem_part_model_fitments f ON f.oem_part_id = op.id
        LEFT JOIN supplier_part_oem_parts sp_link ON sp_link.oem_part_id = op.id
       WHERE std_link.oem_part_id IS NULL
       GROUP BY op.id, op.part_number, op.description_ru, op.description_en, m.name
       ORDER BY supplier_links_count DESC, fitments_count DESC, op.part_number
       LIMIT ${limit}
      `
    )

    const [supplierPartsWithoutStandardLink] = await db.execute(
      `
      SELECT sp.id,
             sp.supplier_part_number,
             sp.description_ru,
             sp.description_en,
             sp.part_type,
             ps.name AS supplier_name,
             COUNT(DISTINCT op_link.oem_part_id) AS oem_links_count,
             CASE
               WHEN sp.weight_kg IS NULL
                 OR sp.length_cm IS NULL
                 OR sp.width_cm IS NULL
                 OR sp.height_cm IS NULL
               THEN 1 ELSE 0
             END AS missing_logistics
        FROM supplier_parts sp
        JOIN part_suppliers ps ON ps.id = sp.supplier_id
        LEFT JOIN supplier_part_standard_parts std_link ON std_link.supplier_part_id = sp.id
        LEFT JOIN supplier_part_oem_parts op_link ON op_link.supplier_part_id = sp.id
       WHERE std_link.supplier_part_id IS NULL
       GROUP BY sp.id, sp.supplier_part_number, sp.description_ru, sp.description_en, sp.part_type, ps.name,
                sp.weight_kg, sp.length_cm, sp.width_cm, sp.height_cm
       ORDER BY oem_links_count DESC, missing_logistics ASC, ps.name, sp.supplier_part_number
       LIMIT ${limit}
      `
    )

    const [standardClassesWithoutFields] = await db.execute(
      `
      SELECT c.id,
             c.name,
             c.code,
             p.name AS parent_name,
             COUNT(DISTINCT sp.id) AS parts_count
        FROM standard_part_classes c
        LEFT JOIN standard_part_classes p ON p.id = c.parent_id
        LEFT JOIN standard_part_class_fields f ON f.class_id = c.id
        LEFT JOIN standard_parts sp ON sp.class_id = c.id
       WHERE f.id IS NULL
       GROUP BY c.id, c.name, c.code, p.name
       ORDER BY parts_count DESC, c.name
       LIMIT ${limit}
      `
    )

    res.json({
      counts: counts || {},
      queues: {
        equipment_models_without_classifier: modelsWithoutClassifier,
        oem_without_standard_link: oemWithoutStandardLink,
        supplier_parts_without_standard_link: supplierPartsWithoutStandardLink,
        standard_classes_without_fields: standardClassesWithoutFields,
      },
    })
  } catch (err) {
    console.error('GET /catalog-health/summary error:', err)
    res.status(500).json({ message: 'Ошибка сервера при расчете качества каталогов' })
  }
})

module.exports = router
