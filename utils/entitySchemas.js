module.exports = {
  // === ТН ВЭД ===
  tnved_codes: {
    table: "tnved_codes",
    uniqueField: "code",
    requiredFields: ["code"],
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/tnved_codes_template.xlsx",
    headerMap: {
      "Код": "code",
      "Описание": "description",
      "Ставка пошлины (%)": "duty_rate",
      "Примечания": "notes"
    },
    transform: (row) => ({
      code: String(row["code"] || "").trim(),
      description: row["description"]?.trim() || null,
      duty_rate: row["duty_rate"] ?? null,
      notes: row["notes"]?.trim() || null
    })
  },

  // === Поставщики ===
  part_suppliers: {
    table: "part_suppliers",
    uniqueField: "vat_number", // единообразно с БД
    requiredFields: ["name"],
    templateUrl: "https://storage.googleapis.com/shared-parts-bucket/templates/suppliers_template.xlsx",
    headerMap: {
      "Название (обязательно)": "name",
      "VAT / ИНН": "vat_number",
      "Страна (ISO2)": "country",
      "Сайт": "website",
      "Контактное лицо": "contact_person",
      "Email": "email",
      "Телефон": "phone",
      // "Адрес (строкой)" — удалено
      "Условия оплаты": "payment_terms",
      "Валюта (ISO3)": "preferred_currency",
      "Инкотермс": "incoterms",
      "Срок поставки, дни": "default_lead_time_days",
      "Примечания": "notes"
    },
    transform: (row) => {
      const trim = (v) => (typeof v === "string" ? v.trim() : v)
      const nz = (v) => (v === "" || v === undefined ? null : v)
      const up = (v, n) =>
        typeof v === "string" ? v.trim().toUpperCase().slice(0, n || v.length) : v ?? null

      return {
        name: trim(row.name || ""),
        vat_number: nz(trim(row.vat_number)),
        country: nz(up(row.country, 2)),
        website: nz(trim(row.website)),
        contact_person: nz(trim(row.contact_person)),
        email: nz(trim(row.email)),
        phone: nz(trim(row.phone)),
        // address — удалено
        payment_terms: nz(up(row.payment_terms)),
        preferred_currency: nz(up(row.preferred_currency, 3)),
        incoterms: nz(up(row.incoterms)),
        default_lead_time_days:
          row.default_lead_time_days === "" || row.default_lead_time_days === undefined
            ? null
            : Number(row.default_lead_time_days),
        notes: nz(trim(row.notes))
      }
    }
  }
}
