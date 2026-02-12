// utils/entitySchemas.js
//
// 🧩 Как добавить НОВЫЙ импорт:
//
// 1) Создаёшь новый ключ в module.exports, например:
//
//    my_entity: {
//      table: "my_table",
//      uniqueField: "some_unique_column",
//      requiredFields: ["name"],
//      templateUrl: "https://.../my_entity_template.xlsx",
//      headerMap: { "Имя": "name", "Код": "code" },
//      // (опционально) serverTransform: (rows, ctx) => rows.map(...),
//      // (опционально) mode: "upsert" | "insert",
//      // (опционально) disableExistingCheck: true/false,
//    }
//
// 2) В шаблоне Excel заголовки должны совпадать с ключами headerMap.
// 3) Если нужна сложная логика (контекст: client_id, model_id, и т.п.),
//    реализуешь serverTransform(rows, ctx) — он вызывается в /routes/import.js.
//

const db = require("./db")
const { normalizeUom } = require("./uom")

module.exports = {
  // === ТН ВЭД ===
  tnved_codes: {
    table: "tnved_codes",

    // 🔹 Уникальность внутри файла: искусственное поле _file_key (code + description)
    uniqueField: "_file_key",

    // 🔹 Обязательное поле
    requiredFields: ["code"],

    // 🔹 Режим:
    //   - "insert": импорт ТОЛЬКО добавляет записи, без обновления
    //   - для ТН ВЭД мы не хотим upsert по одному коду
    mode: "insert",

    // 🔹 Не искать существующие строки в БД по uniqueField (его нет в таблице)
    //    Дубликаты в БД ловятся по уникальному индексу (code, description).
    disableExistingCheck: true,

    templateUrl:
      "https://storage.googleapis.com/shared-parts-bucket/templates/tnved_codes_template.xlsx",

    // Эти заголовки используются на фронте для маппинга колонок Excel → поля
    headerMap: {
      "Код": "code",
      "Описание": "description",
      "Ставка пошлины (%)": "duty_rate",
      "Примечания": "notes",
    },

    // transform здесь скорее "декларативный" — основной маппинг делаем в serverTransform
    transform: (row) => ({
      code: String(row["code"] || "").trim(),
      description: row["description"]?.trim() || null,
      duty_rate: row["duty_rate"] ?? null,
      notes: row["notes"]?.trim() || null,
    }),

    // 👇 Основная серверная логика для импорта ТН ВЭД
    serverTransform: async (rows /*, ctx */) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v)
      const toNull = (v) =>
        v === "" || v === undefined || v === null ? null : v
      const toNumberOrNull = (v) => {
        if (v === "" || v === undefined || v === null) return null
        const n = Number(String(v).replace(",", "."))
        return Number.isFinite(n) ? n : null
      }

      return rows.map((r) => {
        const code = String(r.code ?? r["code"] ?? "").trim()
        const descRaw = r.description ?? r["description"] ?? ""
        const description = toNull(trim(descRaw || ""))
        const notesRaw = r.notes ?? r["notes"] ?? ""
        const notes = toNull(trim(notesRaw || ""))

        return {
          code,
          description,
          duty_rate: toNumberOrNull(r.duty_rate ?? r["duty_rate"]),
          notes,
          // ❗ Искусственный ключ для проверки ПОЛНОГО совпадения внутри файла
          _file_key: `${code}||${description || ""}`,
        }
      })
    },
  },

  // === Поставщики (справочник) ===
  part_suppliers: {
    table: "part_suppliers",
    uniqueField: "vat_number",
    requiredFields: ["name"],
    templateUrl:
      "https://storage.googleapis.com/shared-parts-bucket/templates/suppliers_template.xlsx",
    headerMap: {
      "Название (обязательно)": "name",
      "VAT / ИНН": "vat_number",
      "Страна (ISO2)": "country",
      "Сайт": "website",
      "Условия оплаты": "payment_terms",
      "Валюта (ISO3)": "preferred_currency",
      "Инкотермс": "default_incoterms",
      "Срок поставки, дни": "default_lead_time_days",
      "Примечания": "notes",
    },
    transform: (row) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v)
      const nz = (v) => (v === "" || v === undefined ? null : v)
      const up = (v, n) =>
        typeof v === "string"
          ? v.trim().toUpperCase().slice(0, n || v.length)
          : v ?? null

      return {
        name: trim(row.name || ""),
        vat_number: nz(trim(row.vat_number)),
        country: nz(up(row.country, 2)),
        website: nz(trim(row.website)),
        payment_terms: nz(up(row.payment_terms)),
        preferred_currency: nz(up(row.preferred_currency, 3)),
        default_incoterms: nz(up(row.default_incoterms ?? row.incoterms)),
        default_lead_time_days:
          row.default_lead_time_days === "" ||
          row.default_lead_time_days === undefined
            ? null
            : Number(row.default_lead_time_days),
        notes: nz(trim(row.notes)),
      }
    },
    // mode / disableExistingCheck не заданы → по умолчанию upsert по uniqueField
  },

  // alias для фронта (type="suppliers")
  suppliers: null, // placeholder

  // === ОРИГИНАЛЬНЫЕ ДЕТАЛИ ===
  original_parts: {
    table: "original_parts",
    uniqueField: "cat_number",
    requiredFields: ["cat_number"],

    templateUrl:
      "https://storage.googleapis.com/shared-parts-bucket/templates/original_parts_template.xlsx",

    headerMap: {
      "Part number*": "cat_number",
      "Description (EN)": "description_en",
      "Описание (RU)": "description_ru",
      "Тех. описание": "tech_description",
      "Тех. Описание": "tech_description",
      "Вес, кг": "weight_kg",
      "Ед. изм.": "uom",
      "Ед. изм": "uom",
    },

    transform: (row) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v)
      const nz = (v) => (v === "" || v === undefined ? null : v)
      const num = (v) =>
        v === "" || v === undefined || v === null ? null : Number(v)

      return {
        cat_number: trim(row.cat_number || ""),
        description_en: nz(trim(row.description_en)),
        description_ru: nz(trim(row.description_ru)),
        tech_description: nz(trim(row.tech_description)),
        weight_kg: num(row.weight_kg),
        uom: normalizeUom(trim(row.uom || "")).uom,
      }
    },

    // сервер подставляет модель из контекста импорта
    serverTransform: async (rows, ctx) => {
      const modelId = Number(
        ctx?.equipment_model_id ??
          ctx?.req?.query?.equipment_model_id ??
          ctx?.req?.body?.context?.equipment_model_id
      )
      if (!Number.isFinite(modelId)) {
        const err = new Error("MISSING_EQUIPMENT_MODEL_ID")
        err.status = 400
        throw err
      }

      const [m] = await db.execute(
        "SELECT id FROM equipment_models WHERE id=?",
        [modelId]
      )
      if (!m.length) {
        const err = new Error("EQUIPMENT_MODEL_NOT_FOUND")
        err.status = 400
        throw err
      }

      return rows.map((r) => ({
        ...r,
        equipment_model_id: modelId,
        tnved_code_id: null,
      }))
    },
  },

  // === ДЕТАЛИ ПОСТАВЩИКА (каталог конкретного поставщика) ===
  supplier_parts: {
    table: "supplier_parts",
    // импорт всегда выполняется в контексте ОДНОГО supplier_id → хватает уникальности по номеру
    uniqueField: "supplier_part_number",
    requiredFields: ["supplier_part_number"],
    templateUrl:
      "https://storage.googleapis.com/shared-parts-bucket/templates/supplier_parts_template.xlsx",

    headerMap: {
      "Номер у поставщика*": "supplier_part_number",
      "Описание (RU)": "description_ru",
      "Description (EN)": "description_en",
      "Описание": "description_ru",
    },

    transform: (row) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v)
      const nz = (v) => (v === "" || v === undefined ? null : v)
      return {
        supplier_part_number: trim(row.supplier_part_number || ""),
        description_ru: nz(trim(row.description_ru)),
        description_en: nz(trim(row.description_en)),
      }
    },

    // сервер проставляет supplier_id из контекста импорта
    serverTransform: async (rows, ctx) => {
      const supplierId = Number(
        ctx?.supplier_id ??
          ctx?.req?.query?.supplier_id ??
          ctx?.req?.body?.context?.supplier_id
      )
      if (!Number.isFinite(supplierId)) {
        const err = new Error("MISSING_SUPPLIER_ID")
        err.status = 400
        throw err
      }

      const [s] = await db.execute(
        "SELECT id FROM part_suppliers WHERE id = ?",
        [supplierId]
      )
      if (!s.length) {
        const err = new Error("SUPPLIER_NOT_FOUND")
        err.status = 400
        throw err
      }

      return rows.map((r) => ({
        ...r,
        supplier_id: supplierId,
      }))
    },
    // mode / disableExistingCheck не заданы → дефолтный upsert по supplier_part_number
  },
}

// alias для фронта (type="suppliers")
module.exports.suppliers = module.exports.part_suppliers
