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
            FROM catalog_positions cp
           WHERE cp.is_active = 1
             AND cp.source_kind = 'model_bom'
             AND (
               JSON_EXTRACT(cp.meta_json, '$.weight_kg') IS NULL
               OR JSON_EXTRACT(cp.meta_json, '$.length_cm') IS NULL
               OR JSON_EXTRACT(cp.meta_json, '$.width_cm') IS NULL
               OR JSON_EXTRACT(cp.meta_json, '$.height_cm') IS NULL
             )
        ) AS catalog_positions_missing_logistics,
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
             COUNT(DISTINCT item.catalog_position_id) AS catalog_positions_count,
             COUNT(DISTINCT ceu.id) AS client_units_count
        FROM equipment_models em
        JOIN equipment_manufacturers m ON m.id = em.manufacturer_id
        LEFT JOIN equipment_model_bom_items item ON item.equipment_model_id = em.id
        LEFT JOIN client_equipment_units ceu ON ceu.equipment_model_id = em.id
       WHERE em.classifier_node_id IS NULL
       GROUP BY em.id, em.model_name, em.model_code, m.id, m.name
       ORDER BY catalog_positions_count DESC, client_units_count DESC, m.name, em.model_name
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
