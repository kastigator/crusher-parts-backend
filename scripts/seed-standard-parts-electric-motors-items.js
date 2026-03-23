const db = require("../utils/db")
const {
  buildDisplayName,
  buildSearchText,
  normalizeFieldInput,
} = require("../utils/standardParts")

async function fetchClassBundleByCode(code) {
  const [[classRow]] = await db.execute(
    "SELECT * FROM standard_part_classes WHERE code = ? LIMIT 1",
    [code]
  )
  if (!classRow) return null

  const [fields] = await db.execute(
    `
    SELECT *
      FROM standard_part_class_fields
     WHERE class_id = ?
     ORDER BY sort_order ASC, id ASC
    `,
    [classRow.id]
  )

  const fieldIds = fields.map((field) => field.id)
  const optionsByFieldId = new Map()
  if (fieldIds.length) {
    const placeholders = fieldIds.map(() => "?").join(",")
    const [optionRows] = await db.execute(
      `
      SELECT *
        FROM standard_part_field_options
       WHERE field_id IN (${placeholders})
       ORDER BY sort_order ASC, id ASC
      `,
      fieldIds
    )
    optionRows.forEach((row) => {
      const list = optionsByFieldId.get(Number(row.field_id)) || []
      list.push(row)
      optionsByFieldId.set(Number(row.field_id), list)
    })
  }

  return {
    classRow,
    fields,
    fieldsByCode: new Map(fields.map((field) => [field.code, field])),
    fieldsById: new Map(fields.map((field) => [Number(field.id), field])),
    optionsByFieldId,
  }
}

async function getPartByDesignation(classId, designation) {
  const [[row]] = await db.execute(
    `
    SELECT id, class_id, designation, display_name
      FROM standard_parts
     WHERE class_id = ? AND designation = ?
     LIMIT 1
    `,
    [classId, designation]
  )
  return row || null
}

async function createStandardPart(bundle, payload) {
  const existing = await getPartByDesignation(bundle.classRow.id, payload.designation)
  if (existing) return existing

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [insert] = await conn.execute(
      `
      INSERT INTO standard_parts
        (class_id, display_name, display_name_norm, designation, uom, description_ru, description_en, notes, attributes_search_text, is_active)
      VALUES (?, '', NULL, ?, ?, ?, ?, ?, NULL, 1)
      `,
      [
        bundle.classRow.id,
        payload.designation,
        "pcs",
        payload.description_ru || null,
        payload.description_en || null,
        payload.notes || null,
      ]
    )

    const valueRows = []
    for (const [fieldCode, rawValue] of Object.entries(payload.attributes || {})) {
      const field = bundle.fieldsByCode.get(fieldCode)
      if (!field) continue
      const normalized = normalizeFieldInput(field, rawValue)
      if (normalized.error) throw new Error(normalized.error)
      valueRows.push({
        field_id: Number(field.id),
        value_text: normalized.value_text === undefined ? null : normalized.value_text || null,
        value_number: normalized.value_number === undefined ? null : normalized.value_number,
        value_boolean: normalized.value_boolean === undefined ? null : normalized.value_boolean,
        value_date: normalized.value_date === undefined ? null : normalized.value_date,
        value_json: normalized.value_json === undefined ? null : normalized.value_json,
      })
    }

    if (valueRows.length) {
      const placeholders = valueRows.map(() => "(?,?,?,?,?,?,?)").join(",")
      const values = []
      valueRows.forEach((row) => {
        values.push(
          insert.insertId,
          row.field_id,
          row.value_text,
          row.value_number,
          row.value_boolean,
          row.value_date,
          row.value_json
        )
      })
      await conn.execute(
        `
        INSERT INTO standard_part_values
          (standard_part_id, field_id, value_text, value_number, value_boolean, value_date, value_json)
        VALUES ${placeholders}
        `,
        values
      )
    }

    const valuesByFieldId = new Map(
      valueRows.map((row) => [
        Number(row.field_id),
        {
          field_id: row.field_id,
          value_text: row.value_text,
          value_number: row.value_number,
          value_boolean: row.value_boolean,
          value_date: row.value_date,
          value_json: row.value_json,
        },
      ])
    )

    const optionsLabelMap = new Map()
    bundle.optionsByFieldId.forEach((rows, fieldId) => {
      optionsLabelMap.set(
        Number(fieldId),
        new Map(rows.map((row) => [String(row.value_code), row.value_label]))
      )
    })

    const displayName = buildDisplayName({
      classRow: bundle.classRow,
      fields: bundle.fields,
      valuesByFieldId,
      optionsByFieldId: optionsLabelMap,
      designation: payload.designation,
    })

    const searchText = buildSearchText({
      classRow: bundle.classRow,
      displayName,
      designation: payload.designation,
      descriptions: [payload.description_ru, payload.description_en, payload.notes],
      values: valueRows,
      fieldsById: bundle.fieldsById,
      optionsByFieldId: optionsLabelMap,
    })

    const displayNameNorm = String(displayName || "")
      .trim()
      .toUpperCase()
      .replace(/[\s.-]+/g, "")

    await conn.execute(
      `
      UPDATE standard_parts
         SET display_name = ?,
             display_name_norm = ?,
             attributes_search_text = ?
       WHERE id = ?
      `,
      [displayName, displayNameNorm || null, searchText, insert.insertId]
    )

    await conn.commit()
    return getPartByDesignation(bundle.classRow.id, payload.designation)
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    throw err
  } finally {
    conn.release()
  }
}

async function main() {
  const bundle = await fetchClassBundleByCode("electric_motors")
  if (!bundle) {
    throw new Error("Класс 'Электродвигатели' не найден. Сначала выполните seed класса.")
  }

  const parts = [
    {
      designation: "MTR-7.5KW-380V-1500-B3-IP55",
      description_ru: "Асинхронный электродвигатель 7.5 кВт, 380 В, 1500 об/мин, B3, IP55",
      notes: "Демонстрационная позиция для проверки сложного класса с числовыми и списочными полями.",
      attributes: {
        power_kw: 7.5,
        voltage_v: 380,
        rpm: 1500,
        protection_rating: "ip55",
        mounting_type: "b3",
        frame_size: "132S",
        frequency_hz: 50,
        standard: "IEC 60034",
      },
    },
    {
      designation: "MTR-11KW-380V-1500-B35-IP55",
      description_ru: "Асинхронный электродвигатель 11 кВт, 380 В, 1500 об/мин, B35, IP55",
      notes: "Демонстрационная позиция с комбинированным монтажным исполнением.",
      attributes: {
        power_kw: 11,
        voltage_v: 380,
        rpm: 1500,
        protection_rating: "ip55",
        mounting_type: "b35",
        frame_size: "160M",
        frequency_hz: 50,
        standard: "IEC 60034",
      },
    },
    {
      designation: "MTR-15KW-660V-3000-B5-IP65",
      description_ru: "Асинхронный электродвигатель 15 кВт, 660 В, 3000 об/мин, B5, IP65",
      notes: "Демонстрационная позиция с повышенной степенью защиты.",
      attributes: {
        power_kw: 15,
        voltage_v: 660,
        rpm: 3000,
        protection_rating: "ip65",
        mounting_type: "b5",
        frame_size: "160L",
        frequency_hz: 50,
        standard: "IEC 60034",
      },
    },
  ]

  const created = []
  for (const part of parts) {
    const row = await createStandardPart(bundle, part)
    created.push(row)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        class: {
          id: bundle.classRow.id,
          code: bundle.classRow.code,
          name: bundle.classRow.name,
        },
        parts: created,
      },
      null,
      2
    )
  )
}

main()
  .catch((err) => {
    console.error("seed-standard-parts-electric-motors-items failed:", err)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.end()
  })
