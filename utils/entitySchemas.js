module.exports = {
  // === ТН ВЭД (как у тебя было) ===
  tnved_codes: {
    table: "tnved_codes",
    uniqueField: "code",
    requiredFields: ["code"],
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/tnved_codes_template.xlsx",

    // Связь между заголовками в Excel и полями в БД
    headerMap: {
      "Код": "code",
      "Описание": "description",
      "Ставка пошлины (%)": "duty_rate",
      "Примечания": "notes"
    },

    // Преобразование уже по техническим названиям (после маппинга на фронте)
    transform: (row) => ({
      code: String(row["code"] || "").trim(),
      description: row["description"]?.trim() || null,
      duty_rate: row["duty_rate"] ?? null,
      notes: row["notes"]?.trim() || null
    })
  },

  // === Поставщики (part_suppliers) ===
  part_suppliers: {
    table: "part_suppliers",
    // уникальность проверяем в таком порядке: сначала по supplier_code, потом по vat_number
    uniqueBy: ["supplier_code", "vat_number"],
    requiredFields: ["name"],
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/suppliers_template.xlsx",

    // Заголовки в шаблоне (человеческие) -> технические поля БД
    headerMap: {
      "Код поставщика": "supplier_code",
      "Внешний ID": "external_id",
      "Название (обязательно)": "name",
      "VAT / ИНН": "vat_number",
      "Страна (ISO2)": "country",
      "Сайт": "website",
      "Контактное лицо": "contact_person",
      "Email": "email",
      "Телефон": "phone",
      "Адрес (строкой)": "address",
      "Условия оплаты": "payment_terms",
      "Валюта (ISO3)": "preferred_currency",
      "Инкотермс": "incoterms",
      "Срок поставки, дни": "default_lead_time_days",
      "OEM (0/1)": "is_oem",
      "Сертифицирован (0/1)": "quality_certified",
      "Активен (0/1)": "active",
      "Примечания": "notes"
    },

    // Нормализация значений (после маппинга в технические имена)
    transform: (row) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v);
      const nz = (v) => (v === "" || v === undefined ? null : v);
      const up = (v, n) => (typeof v === "string" ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null);
      const bool01 = (v, def = 0) =>
        v === true || v === 1 || v === "1" || (typeof v === "string" && v.toLowerCase() === "true")
          ? 1
          : v === false || v === 0 || v === "0" || (typeof v === "string" && v.toLowerCase() === "false")
          ? 0
          : def;

      return {
        supplier_code: nz(trim(row["supplier_code"])) || null,
        external_id: nz(trim(row["external_id"])) || null,
        name: trim(row["name"] || row["Название (обязательно)"] || ""), // safety
        vat_number: nz(trim(row["vat_number"])) || null,

        country: nz(up(row["country"], 2)) || null,               // ISO2
        website: nz(trim(row["website"])) || null,
        contact_person: nz(trim(row["contact_person"])) || null,
        email: nz(trim(row["email"])) || null,
        phone: nz(trim(row["phone"])) || null,
        address: nz(trim(row["address"])) || null,

        payment_terms: nz(up(row["payment_terms"])) || null,      // PREPAID/NET30/...
        preferred_currency: nz(up(row["preferred_currency"], 3)) || null, // ISO3
        incoterms: nz(up(row["incoterms"])) || null,              // EXW/FCA/...

        default_lead_time_days:
          row["default_lead_time_days"] === "" || row["default_lead_time_days"] === undefined
            ? null
            : Number(row["default_lead_time_days"]),

        is_oem: bool01(row["is_oem"], 0),
        quality_certified: bool01(row["quality_certified"], 0),
        active: bool01(row["active"], 1),
        notes: nz(trim(row["notes"])) || null
      };
    }
  }
};
