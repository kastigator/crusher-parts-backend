const axios = require('axios')
const jwt = require('jsonwebtoken')
const db = require('../utils/db')

const API_BASE_URL = process.env.SMOKE_API_BASE_URL || 'http://127.0.0.1:5050/api'
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key'

function buildToken() {
  return jwt.sign(
    {
      id: 4,
      username: 'smoke_admin',
      full_name: 'Smoke Admin',
      role_id: 1,
      role: 'admin',
      permissions: [],
      capabilities: [],
    },
    JWT_SECRET,
    { expiresIn: '30m' }
  )
}

async function ensureServerAvailable(client) {
  try {
    await client.get('/standard-part-classes', { params: { limit: 1 } })
  } catch (err) {
    const status = err?.response?.status
    if (status === 401 || status === 403) {
      throw new Error('Backend доступен, но токен не прошел проверку')
    }
    throw new Error(`Не удалось достучаться до API ${API_BASE_URL}. Поднимите backend и повторите smoke-тест.`)
  }
}

async function pickManufacturerAndModel() {
  const [rows] = await db.execute(
    `
    SELECT em.id AS manufacturer_id,
           em.name AS manufacturer_name,
           mdl.id AS model_id,
           mdl.model_name AS model_name
      FROM equipment_manufacturers em
      JOIN equipment_models mdl ON mdl.manufacturer_id = em.id
     ORDER BY em.id ASC, mdl.id ASC
     LIMIT 1
    `
  )

  if (!rows.length) {
    throw new Error('В базе нет ни одной пары производитель/модель для smoke-теста OEM-представления')
  }

  return rows[0]
}

async function pickSupplier() {
  const [rows] = await db.execute(
    `
    SELECT id AS supplier_id, name AS supplier_name
      FROM part_suppliers
     ORDER BY id ASC
     LIMIT 1
    `
  )

  if (!rows.length) {
    throw new Error('В базе нет поставщиков для smoke-теста представления поставщика')
  }

  return rows[0]
}

async function cleanupArtifacts(ids) {
  if (ids.supplierPartId) {
    await db.execute('DELETE FROM supplier_part_prices WHERE supplier_part_id = ?', [ids.supplierPartId])
    await db.execute('DELETE FROM supplier_part_standard_parts WHERE supplier_part_id = ?', [ids.supplierPartId])
    await db.execute('DELETE FROM supplier_part_oem_parts WHERE supplier_part_id = ?', [ids.supplierPartId])
    await db.execute('DELETE FROM supplier_parts WHERE id = ?', [ids.supplierPartId])
  }

  if (ids.oemPartId) {
    await db.execute('DELETE FROM oem_part_model_fitments WHERE oem_part_id = ?', [ids.oemPartId])
    await db.execute('DELETE FROM oem_part_standard_parts WHERE oem_part_id = ?', [ids.oemPartId])
    await db.execute('DELETE FROM oem_parts WHERE id = ?', [ids.oemPartId])
  }

  if (ids.standardPartId) {
    await db.execute('DELETE FROM supplier_part_standard_parts WHERE standard_part_id = ?', [ids.standardPartId])
    await db.execute('DELETE FROM oem_part_standard_parts WHERE standard_part_id = ?', [ids.standardPartId])
    await db.execute('DELETE FROM standard_part_values WHERE standard_part_id = ?', [ids.standardPartId])
    await db.execute('DELETE FROM standard_parts WHERE id = ?', [ids.standardPartId])
  }

  if (ids.classId) {
    await db.execute(
      'DELETE o FROM standard_part_field_options o JOIN standard_part_class_fields f ON f.id = o.field_id WHERE f.class_id = ?',
      [ids.classId]
    )
    await db.execute('DELETE FROM standard_part_class_fields WHERE class_id = ?', [ids.classId])
    await db.execute('DELETE FROM standard_part_classes WHERE id = ?', [ids.classId])
  }
}

async function main() {
  const token = buildToken()
  const client = axios.create({
    baseURL: API_BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  })

  const ids = {
    classId: null,
    standardPartId: null,
    oemPartId: null,
    supplierPartId: null,
  }

  try {
    await ensureServerAvailable(client)
    const fitment = await pickManufacturerAndModel()
    const supplier = await pickSupplier()
    const suffix = Date.now()

    const { data: createdClass } = await client.post('/standard-part-classes', {
      name: `Smoke Электродвигатели ${suffix}`,
      code: `smoke_electric_motor_${suffix}`,
      description: 'Тестовый класс для smoke-проверки классификатора стандартных деталей',
      sort_order: 0,
      is_active: 1,
    })
    ids.classId = createdClass.id

    const { data: powerField } = await client.post(`/standard-part-classes/${ids.classId}/fields`, {
      code: `power_kw_${suffix}`,
      label: 'Мощность, кВт',
      field_type: 'number',
      sort_order: 10,
      is_required: 1,
      is_active: 1,
      is_in_title: 1,
      is_in_list: 1,
      is_in_filters: 1,
      is_searchable: 1,
      unit: 'кВт',
      placeholder: 'Например, 7.5',
      help_text: 'Номинальная мощность двигателя',
    })

    const { data: voltageField } = await client.post(`/standard-part-classes/${ids.classId}/fields`, {
      code: `voltage_v_${suffix}`,
      label: 'Напряжение, В',
      field_type: 'number',
      sort_order: 20,
      is_required: 1,
      is_active: 1,
      is_in_title: 1,
      is_in_list: 1,
      is_in_filters: 1,
      is_searchable: 1,
      unit: 'В',
      placeholder: 'Например, 380',
      help_text: 'Рабочее напряжение',
    })

    const { data: part } = await client.post('/standard-parts', {
      class_id: ids.classId,
      designation: `SMOKE-MOTOR-${suffix}`,
      uom: 'pcs',
      description_ru: 'Тестовый электродвигатель для smoke-проверки',
      is_active: 1,
      attributes: [
        { field_id: powerField.id, value: 7.5 },
        { field_id: voltageField.id, value: 380 },
      ],
    })
    ids.standardPartId = part.id

    const { data: createdOem } = await client.post(`/standard-parts/${ids.standardPartId}/create-oem-representation`, {
      manufacturer_id: fitment.manufacturer_id,
      equipment_model_ids: [fitment.model_id],
      part_number: `SMOKE-OEM-${suffix}`,
      description_ru: 'Smoke OEM-представление стандартной детали',
      uom: 'pcs',
      note: 'Создано smoke-скриптом',
    })
    ids.oemPartId = createdOem.id

    const { data: createdSupplierPart } = await client.post(
      `/standard-parts/${ids.standardPartId}/create-supplier-representation`,
      {
        supplier_id: supplier.supplier_id,
        supplier_part_number: `SMOKE-SUP-${suffix}`,
        description_ru: 'Smoke supplier representation',
        uom: 'pcs',
        lead_time_days: 14,
        min_order_qty: 5,
        packaging: 'Коробка',
        part_type: 'ANALOG',
        is_preferred: 1,
        initial_price: 12.5,
        initial_currency: 'USD',
      }
    )
    ids.supplierPartId = createdSupplierPart.id

    const { data: workspace } = await client.get(`/standard-part-classes/${ids.classId}/workspace`)
    const createdPart = Array.isArray(workspace?.parts)
      ? workspace.parts.find((row) => Number(row.id) === Number(ids.standardPartId))
      : null
    const createdRepresentation = Array.isArray(workspace?.oem_representations)
      ? workspace.oem_representations.find((row) => Number(row.oem_part_id) === Number(ids.oemPartId))
      : null
    const createdSupplierRepresentation = Array.isArray(workspace?.supplier_representations)
      ? workspace.supplier_representations.find((row) => Number(row.supplier_part_id) === Number(ids.supplierPartId))
      : null

    if (!createdPart) {
      throw new Error('Созданная стандартная деталь не появилась в workspace класса')
    }
    if (!createdRepresentation) {
      throw new Error('Созданное OEM-представление не появилось в workspace класса')
    }
    if (!createdSupplierRepresentation) {
      throw new Error('Созданное представление поставщика не появилось в workspace класса')
    }

    console.log('smoke-standard-parts-classifier ok')
    console.log(`Класс: ${createdClass.name} (#${ids.classId})`)
    console.log(`Стандартная деталь: ${createdPart.display_name} (#${ids.standardPartId})`)
    console.log(`OEM-представление: ${createdOem.part_number} (#${ids.oemPartId})`)
    console.log(`Представление поставщика: ${createdSupplierPart.supplier_part_number} (#${ids.supplierPartId})`)
    console.log(`Производитель/модель: ${fitment.manufacturer_name} / ${fitment.model_name}`)
    console.log(`Поставщик: ${supplier.supplier_name}`)
  } finally {
    await cleanupArtifacts(ids)
    await db.end()
  }
}

main().catch((err) => {
  console.error('smoke-standard-parts-classifier failed')
  console.error(err.message || err)
  process.exit(1)
})
