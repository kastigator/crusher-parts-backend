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
//      templateFileName: "my_entity_template.xlsx",
//      templateSheetName: "import",
//      templateExampleRows: [{ name: "Пример" }],
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

const toNull = (v) => (v === "" || v === undefined || v === null ? null : v)
const toNumberOrNull = (v) => {
  if (v === "" || v === undefined || v === null) return null
  const n = Number(String(v).replace(",", "."))
  return Number.isFinite(n) ? n : null
}
const toBoolTinyint = (v, fallback = null) => {
  if (v === "" || v === undefined || v === null) return fallback
  if (typeof v === "boolean") return v ? 1 : 0
  const s = String(v).trim().toLowerCase()
  if (["1", "true", "yes", "y", "да"].includes(s)) return 1
  if (["0", "false", "no", "n", "нет"].includes(s)) return 0
  return fallback
}
const SUPPLIER_DEFAULT_PAYMENT_TERMS = [
  "100% предоплата",
  "30% предоплата / 70% перед отгрузкой",
  "50% предоплата / 50% перед отгрузкой",
  "Оплата по факту отгрузки",
  "NET 30",
  "NET 45",
  "Аккредитив",
  "По договоренности",
]
const normalizeSupplierPaymentTerms = (v) => {
  const raw = String(v || "").trim().replace(/\s+/g, " ")
  if (!raw) return null
  const upper = raw.toUpperCase()
  return (
    SUPPLIER_DEFAULT_PAYMENT_TERMS.find((item) => item.toUpperCase() === upper) ||
    null
  )
}
const normalizeCurrency = (v) => {
  const raw = String(v || "").trim().toUpperCase()
  return raw ? raw.slice(0, 3) : null
}
const normalizePartType = (v) => {
  const raw = String(v || "").trim().toUpperCase()
  return ["OEM", "ANALOG", "UNKNOWN"].includes(raw) ? raw : "UNKNOWN"
}

const resolveTnvedIdFromId = async (idValue) => {
  const numericId = Number(idValue)
  return Number.isInteger(numericId) && numericId > 0 ? numericId : null
}
const resolveTnvedIdFromCode = async (codeValue) => {
  const code = String(codeValue || "").trim()
  if (!code) return null
  const [rows] = await db.execute("SELECT id FROM tnved_codes WHERE code = ? LIMIT 1", [code])
  return rows[0]?.id || null
}

module.exports = {
  // === ТН ВЭД ===
  tnved_codes: {
    table: "tnved_codes",

    // 🔹 Один код ТН ВЭД должен быть одной записью.
    uniqueField: "code",

    // 🔹 Обязательное поле
    requiredFields: ["code"],

    // 🔹 Импорт обновляет существующий код и создаёт новый, если кода ещё нет.
    mode: "upsert",

    templateFileName: "tnved_codes_template.xlsx",
    templateSheetName: "tnved_codes",
    templateReadme: [
      "Используйте один код ТН ВЭД на строку.",
      "Описание можно оставить пустым, если достаточно самого кода.",
      "Ставка пошлины указывается в процентах без знака %.",
    ],

    // Эти заголовки используются на фронте для маппинга колонок Excel → поля
    headerMap: {
      "Код": "code",
      "Описание": "description",
      "Ставка пошлины (%)": "duty_rate",
      "Примечания": "notes",
    },
    templateExampleRows: [
      {
        code: "8474901000",
        description: "Части дробильного оборудования",
        duty_rate: 5,
        notes: "Пример строки",
      },
    ],

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
        }
      })
    },
  },

  // === Поставщики (справочник) ===
  part_suppliers: {
    table: "part_suppliers",
    uniqueBy: ["public_code", "vat_number"],
    uniqueField: "public_code",
    requiredFields: ["name", "public_code"],
    templateFileName: "suppliers_template.xlsx",
    templateSheetName: "suppliers",
    templateReadme: [
      "Заполняйте одного поставщика на строку.",
      "Публичный код поставщика обязателен и должен быть уникальным.",
      "VAT / ИНН желателен как дополнительный идентификатор.",
      "Страна должна быть в ISO2, валюта в ISO3.",
    ],
    headerMap: {
      "Название (обязательно)": "name",
      "Публичный код*": "public_code",
      "VAT / ИНН": "vat_number",
      "Страна (ISO2)": "country",
      "Сайт": "website",
      "Условия оплаты": "payment_terms",
      "Валюта (ISO3)": "preferred_currency",
      "Точка самовывоза / pickup": "default_pickup_location",
      "Работает с OEM (1/0)": "can_oem",
      "Работает с аналогами (1/0)": "can_analog",
      "Срок поставки, дни": "default_lead_time_days",
      "Примечания": "notes",
    },
    templateExampleRows: [
      {
        name: "Hantop Machinery",
        public_code: "SUP-HANTOP",
        vat_number: "CN123456789",
        country: "CN",
        website: "https://example.com",
        payment_terms: "30% предоплата / 70% перед отгрузкой",
        preferred_currency: "USD",
        default_pickup_location: "Shanghai",
        can_oem: 1,
        can_analog: 1,
        default_lead_time_days: 30,
        notes: "Пример поставщика",
      },
    ],
    transform: (row) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v)
      const nz = (v) => (v === "" || v === undefined ? null : v)
      const up = (v, n) =>
        typeof v === "string"
          ? v.trim().toUpperCase().slice(0, n || v.length)
          : v ?? null

      return {
        name: trim(row.name || ""),
        public_code: nz(up(row.public_code, 32)),
        vat_number: nz(trim(row.vat_number)),
        country: nz(up(row.country, 2)),
        website: nz(trim(row.website)),
        payment_terms: normalizeSupplierPaymentTerms(row.payment_terms),
        preferred_currency: normalizeCurrency(row.preferred_currency),
        default_pickup_location: nz(trim(row.default_pickup_location)),
        can_oem: toBoolTinyint(row.can_oem, 0),
        can_analog: toBoolTinyint(row.can_analog, 1),
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

  // === ДЕТАЛИ ПОСТАВЩИКА (каталог конкретного поставщика) ===
  supplier_parts: {
    table: "supplier_parts",
    // импорт всегда выполняется в контексте ОДНОГО supplier_id → хватает уникальности по номеру
    uniqueField: "supplier_part_number",
    requiredFields: ["supplier_part_number"],
    templateFileName: "supplier_parts_template.xlsx",
    templateSheetName: "supplier_parts",
    templateReadme: [
      "Шаблон используется в контексте выбранного поставщика.",
      "Номер у поставщика обязателен и служит ключом upsert.",
      "Описание можно заполнять на русском и/или английском.",
      "Вес и габариты используются в RFQ логистике и экономике.",
    ],

    headerMap: {
      "Номер у поставщика*": "supplier_part_number",
      "Описание (RU)": "description_ru",
      "Description (EN)": "description_en",
      "Описание": "description_ru",
      "Ед. изм.": "uom",
      "Комментарий": "comment",
      "Срок поставки, дни": "lead_time_days",
      "MOQ": "min_order_qty",
      "Упаковка": "packaging",
      "Активна (1/0)": "active",
      "Каталожный номер OEM": "original_part_cat_number",
      "Вес, кг": "weight_kg",
      "Длина, см": "length_cm",
      "Ширина, см": "width_cm",
      "Высота, см": "height_cm",
      "Сверхтяжелая (1/0)": "is_overweight",
      "Негабарит (1/0)": "is_oversize",
      "Тип детали": "part_type",
      "Цена": "price",
      "Валюта": "currency",
      "Валюта наценки": "default_fx_currency",
      "Наценка, %": "default_markup_pct",
      "Наценка, сумма": "default_markup_abs",
    },
    templateExampleRows: [
      {
        supplier_part_number: "HT195-27-33111",
        description_ru: "Главный вал, ступень",
        description_en: "Mainshaft step",
        uom: "шт",
        lead_time_days: 30,
        min_order_qty: 1,
        packaging: "Коробка",
        active: 1,
        original_part_cat_number: "HT195-27-33111",
        weight_kg: 12.5,
        length_cm: 80,
        width_cm: 25,
        height_cm: 25,
        is_overweight: 0,
        is_oversize: 0,
        part_type: "OEM",
        price: 1250,
        currency: "USD",
        default_fx_currency: "USD",
        default_markup_pct: 15,
        default_markup_abs: 0,
      },
    ],

    transform: (row) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v)
      const nz = (v) => (v === "" || v === undefined ? null : v)
      return {
        supplier_part_number: trim(row.supplier_part_number || ""),
        description_ru: nz(trim(row.description_ru)),
        description_en: nz(trim(row.description_en)),
        uom: normalizeUom(trim(row.uom || ""), { allowEmpty: true }).uom || "шт",
        comment: nz(trim(row.comment)),
        lead_time_days: toNumberOrNull(row.lead_time_days),
        min_order_qty: toNumberOrNull(row.min_order_qty),
        packaging: nz(trim(row.packaging)),
        active: toBoolTinyint(row.active, 1),
        original_part_cat_number: nz(trim(row.original_part_cat_number)),
        weight_kg: toNumberOrNull(row.weight_kg),
        length_cm: toNumberOrNull(row.length_cm),
        width_cm: toNumberOrNull(row.width_cm),
        height_cm: toNumberOrNull(row.height_cm),
        is_overweight: toBoolTinyint(row.is_overweight, 0),
        is_oversize: toBoolTinyint(row.is_oversize, 0),
        part_type: normalizePartType(row.part_type),
        price: toNumberOrNull(row.price),
        currency: normalizeCurrency(row.currency),
        default_fx_currency: normalizeCurrency(row.default_fx_currency),
        default_markup_pct: toNumberOrNull(row.default_markup_pct),
        default_markup_abs: toNumberOrNull(row.default_markup_abs),
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
    findExisting: async (conn, row) => {
      const [rows] = await conn.execute(
        "SELECT * FROM supplier_parts WHERE supplier_id = ? AND supplier_part_number = ? LIMIT 1",
        [row.supplier_id, row.supplier_part_number]
      )
      return rows[0] || null
    },
    // mode / disableExistingCheck не заданы → дефолтный upsert по supplier_part_number
  },
}

// alias для фронта (type="suppliers")
module.exports.suppliers = module.exports.part_suppliers
