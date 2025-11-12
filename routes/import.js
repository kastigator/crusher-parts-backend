// routes/import.js
const express = require("express")
const router = express.Router()
const importSchemas = require("../utils/entitySchemas")
const { validateImportRows } = require("../utils/importValidator")
const db = require("../utils/db")

const auth = require("../middleware/authMiddleware")
const checkTabAccess = require("../middleware/checkTabAccess")

// ---------------------------------------------------------------------------
// Привязка типов импорта к вкладкам (tabs.path)
// ---------------------------------------------------------------------------
const TAB_MAP = {
  tnved_codes: "/tnved-codes",
  supplier_parts: "/supplier-parts",
  original_parts: "/original-parts",
  clients: "/clients",
  // дополняй по мере подключения:
  // part_suppliers: "/part-suppliers",
  // equipment_models: "/equipment-models",
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const nz = (v) =>
  v === undefined || v === null ? null : ("" + v).trim() || null

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const getTabPathForType = (type) => TAB_MAP[type] || null

// Динамический гард по типу: проверяем доступ к соответствующей вкладке
const guardForType = (param = "type") => (req, res, next) => {
  const type = req.params?.[param] || req.query?.[param] || req.body?.type
  const path = getTabPathForType(type)
  if (!path) {
    return res.status(403).json({ message: "Импорт для этого типа запрещён" })
  }
  return checkTabAccess(path)(req, res, next)
}

// Глобально применяем авторизацию
router.use(auth)

// ---------------------------------------------------------------------------
// Получить схему импорта по типу (templateUrl, headerMap, requiredFields...)
// GET /import/schema/:type
// ---------------------------------------------------------------------------
router.get("/schema/:type", guardForType("type"), (req, res) => {
  const schema = importSchemas[req.params.type]
  if (!schema) return res.status(404).json({ message: "Схема не найдена" })
  res.json(schema)
})

// ---------------------------------------------------------------------------
// Универсальная загрузка данных (rows распарсены фронтом из Excel)
// POST /import/:type
//  body: Array<row> ИЛИ { rows: Array<row>, context?: {...} }
//  query/context: equipment_model_id — для связанного импорта original_parts
// ---------------------------------------------------------------------------
router.post("/:type", guardForType("type"), async (req, res) => {
  try {
    const type = req.params.type
    const schema = importSchemas[type]
    if (!schema) {
      return res.status(400).json({ message: "Схема импорта не найдена" })
    }

    // Поддержка тела как массива строк или объекта с rows
    let rows = Array.isArray(req.body)
      ? req.body
      : Array.isArray(req.body?.rows)
      ? req.body.rows
      : []

    if (!rows.length) {
      return res.status(400).json({ message: "Нет данных для импорта" })
    }

    // Лёгкая защита от аномально больших импортов (можно увеличить при необходимости)
    const MAX_ROWS = 10000
    if (rows.length > MAX_ROWS) {
      return res.status(413).json({
        message: `Слишком много строк для импорта (>${MAX_ROWS})`,
      })
    }

    // Контекст (например, выбранная модель для original_parts)
    const rawModelId =
      req.query?.equipment_model_id ??
      req.body?.context?.equipment_model_id ??
      null
    const equipment_model_id = rawModelId != null ? toId(rawModelId) : null

    const ctx = { db, req, equipment_model_id }

    // serverTransform (если определён в схеме) — например, подставить equipment_model_id
    if (typeof schema.serverTransform === "function") {
      try {
        rows = await schema.serverTransform(rows, ctx)
      } catch (e) {
        // Пробрасываем дружелюбные сообщения
        if (e && (e.message === "MISSING_EQUIPMENT_MODEL_ID" || e.code === "MISSING_EQUIPMENT_MODEL_ID")) {
          return res
            .status(400)
            .json({ message: "Не передан equipment_model_id в контексте импорта" })
        }
        if (e && (e.message === "EQUIPMENT_MODEL_NOT_FOUND" || e.code === "EQUIPMENT_MODEL_NOT_FOUND")) {
          return res
            .status(400)
            .json({ message: "Указанная модель оборудования не найдена" })
        }
        throw e
      }
    }

    // Тип логирования: хотим сводить поставщиков под единый "suppliers" если требуется
    const logType = type === "part_suppliers" ? "suppliers" : type

    // Запускаем универсальную валидацию + upsert
    const result = await validateImportRows(rows, {
      table: schema.table,
      uniqueBy: schema.uniqueBy,            // поддержка составных ключей
      uniqueField: schema.uniqueField,      // обратная совместимость
      requiredFields: schema.requiredFields || [],
      req,
      logType,
      // mode: "upsert" по умолчанию внутри validateImportRows
    })

    return res.status(200).json(result)
  } catch (err) {
    console.error("Ошибка импорта:", err)
    const status = err.status || 500

    // Подхват типовых ошибок, если прилетели не из serverTransform
    if (err && (err.message === "MISSING_EQUIPMENT_MODEL_ID" || err.code === "MISSING_EQUIPMENT_MODEL_ID")) {
      return res
        .status(400)
        .json({ message: "Не передан equipment_model_id в контексте импорта" })
    }
    if (err && (err.message === "EQUIPMENT_MODEL_NOT_FOUND" || err.code === "EQUIPMENT_MODEL_NOT_FOUND")) {
      return res.status(400).json({ message: "Указанная модель оборудования не найдена" })
    }

    return res.status(status).json({ message: "Ошибка сервера при импорте" })
  }
})

module.exports = router
