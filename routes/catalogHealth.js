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
        ) AS supplier_parts_missing_logistics
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

    res.json({
      counts: counts || {},
      queues: {
        equipment_models_without_classifier: modelsWithoutClassifier,
      },
    })
  } catch (err) {
    console.error('GET /catalog-health/summary error:', err)
    res.status(500).json({ message: 'Ошибка сервера при расчете качества каталогов' })
  }
})

module.exports = router
