const fs = require('fs')
const path = require('path')
const db = require('../utils/db')

const MODEL_ID = 1
const METSO_ID = 1
const CONE_NODE_ID = 7
const BOLT_POSITION_ID = 1
const PDF_SOURCE = '/Users/aleksandrlubimov/Downloads/HP800214 & 215.pdf'
const COVER_SOURCE = '/tmp/hp800_seed_pages/hp800_cover.png'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) return null
  ensureDir(path.dirname(target))
  fs.copyFileSync(source, target)
  return fs.statSync(target)
}

async function ensureAttribute(conn, { code, label, valueType = 'number', unit = null, sortOrder = 0, filterable = 1 }) {
  const [[existing]] = await conn.execute(
    'SELECT id FROM equipment_classifier_node_attributes WHERE classifier_node_id = ? AND code = ?',
    [CONE_NODE_ID, code],
  )
  if (existing) {
    await conn.execute(
      `UPDATE equipment_classifier_node_attributes
       SET label = ?, value_type = ?, unit = ?, sort_order = ?, is_filterable = ?, is_active = 1
       WHERE id = ?`,
      [label, valueType, unit, sortOrder, filterable, existing.id],
    )
    return existing.id
  }
  const [ins] = await conn.execute(
    `INSERT INTO equipment_classifier_node_attributes
      (classifier_node_id, code, label, value_type, unit, sort_order, is_required, is_filterable, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1)`,
    [CONE_NODE_ID, code, label, valueType, unit, sortOrder, filterable],
  )
  return ins.insertId
}

async function setModelAttribute(conn, attributeId, { number = null, text = null }) {
  await conn.execute(
    `DELETE FROM equipment_attribute_values
      WHERE attribute_id = ? AND entity_type = 'equipment_model' AND entity_id = ?`,
    [attributeId, MODEL_ID],
  )
  await conn.execute(
    `INSERT INTO equipment_attribute_values
      (attribute_id, entity_type, entity_id, value_text, value_number)
     VALUES (?, 'equipment_model', ?, ?, ?)`,
    [attributeId, MODEL_ID, text, number],
  )
}

async function ensureOemPart(conn, { partNumber, descriptionEn, descriptionRu = null, uom = 'шт', hasDrawing = 0 }) {
  const [result] = await conn.execute(
    `INSERT INTO oem_parts
      (manufacturer_id, classifier_node_id, part_number, description_ru, description_en, uom, has_drawing)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       classifier_node_id = VALUES(classifier_node_id),
       description_ru = COALESCE(VALUES(description_ru), description_ru),
       description_en = COALESCE(VALUES(description_en), description_en),
       uom = VALUES(uom),
       has_drawing = GREATEST(has_drawing, VALUES(has_drawing)),
       id = LAST_INSERT_ID(id)`,
    [METSO_ID, CONE_NODE_ID, partNumber, descriptionRu, descriptionEn, uom, hasDrawing],
  )
  const id = result.insertId
  await conn.execute(
    `INSERT IGNORE INTO oem_part_model_fitments
      (oem_part_id, equipment_model_id, description_ru, description_en, uom)
     VALUES (?, ?, ?, ?, ?)`,
    [id, MODEL_ID, descriptionRu, descriptionEn, uom],
  )
  return id
}

async function addBomItem(conn, byKey, key, row) {
  const parentId = row.parentKey ? byKey.get(row.parentKey) || null : null
  const [ins] = await conn.execute(
    `INSERT INTO equipment_model_bom_items
      (equipment_model_id, parent_item_id, item_type, item_no, manufacturer_part_number,
       manufacturer_part_name, drawing_number, oem_part_id, catalog_position_id, title,
       quantity, sort_order, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      MODEL_ID,
      parentId,
      row.itemType || (row.catalogPositionId ? 'catalog_position' : row.oemPartId ? 'oem_part' : 'group'),
      row.itemNo || null,
      row.partNumber || null,
      row.partName || null,
      row.drawingNumber || null,
      row.oemPartId || null,
      row.catalogPositionId || null,
      row.title || null,
      row.quantity || 1,
      row.sortOrder || 0,
      row.notes || null,
    ],
  )
  byKey.set(key, ins.insertId)
  return ins.insertId
}

async function main() {
  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[model]] = await conn.execute(
      `SELECT m.id, m.model_name, mf.name manufacturer_name
       FROM equipment_models m
       LEFT JOIN equipment_manufacturers mf ON mf.id = m.manufacturer_id
       WHERE m.id = ?`,
      [MODEL_ID],
    )
    if (!model || model.manufacturer_name !== 'Metso' || model.model_name !== 'HP 800') {
      throw new Error(`Ожидалась учебная модель Metso HP 800 с id=${MODEL_ID}`)
    }

    await conn.execute('DELETE FROM equipment_model_bom_items WHERE equipment_model_id = ?', [MODEL_ID])
    await conn.execute('DELETE FROM oem_part_model_bom WHERE equipment_model_id = ?', [MODEL_ID])
    await conn.execute('DELETE FROM oem_part_model_fitments WHERE equipment_model_id = ?', [MODEL_ID])
    await conn.execute('DELETE FROM equipment_model_media WHERE equipment_model_id = ?', [MODEL_ID])
    await conn.execute('DELETE FROM equipment_model_documents WHERE equipment_model_id = ?', [MODEL_ID])
    await conn.execute('DELETE FROM client_equipment_units WHERE equipment_model_id = ?', [MODEL_ID])

    await conn.execute(
      `UPDATE equipment_models
       SET classifier_node_id = ?, notes = ?
       WHERE id = ?`,
      [
        CONE_NODE_ID,
        'Учебная заполненная модель по parts book Nordberg HP800 HP800214 & HP800215. Данные используются для отработки интерфейса классификатора/BOM.',
        MODEL_ID,
      ],
    )

    const attrs = {}
    attrs.power = await ensureAttribute(conn, {
      code: 'motor_power_kw',
      label: 'Мощность двигателя',
      unit: 'кВт',
      sortOrder: 10,
    })
    attrs.mass = await ensureAttribute(conn, {
      code: 'mass_equipment_t',
      label: 'Масса оборудования',
      unit: 'т',
      sortOrder: 20,
    })
    attrs.capacityMin = await ensureAttribute(conn, {
      code: 'capacity_min_tph',
      label: 'Производительность от',
      unit: 'т/ч',
      sortOrder: 30,
    })
    attrs.capacityMax = await ensureAttribute(conn, {
      code: 'capacity_max_tph',
      label: 'Производительность до',
      unit: 'т/ч',
      sortOrder: 40,
    })

    await setModelAttribute(conn, attrs.power, { number: 600 })
    await setModelAttribute(conn, attrs.mass, { number: 68.7 })
    await setModelAttribute(conn, attrs.capacityMin, { number: 160 })
    await setModelAttribute(conn, attrs.capacityMax, { number: 1200 })
    await setModelAttribute(conn, 5, { number: 2134 })
    await setModelAttribute(conn, 6, { number: 353 })
    await setModelAttribute(conn, 7, { number: 13 })
    await setModelAttribute(conn, 8, { number: 51 })
    await setModelAttribute(conn, 9, { text: 'medium' })

    await conn.execute(
      `UPDATE catalog_positions
       SET display_name = ?, description = ?, uom = ?, classifier_node_id = ?, is_active = 1
       WHERE id = ?`,
      [
        'Болт шестигранный M20x80 10.9 DIN 931',
        'Переиспользуемая стандартная позиция классификатора. В BOM производителя может иметь свой каталожный номер.',
        'шт',
        120,
        BOLT_POSITION_ID,
      ],
    )

    const partIds = {}
    const partRows = [
      ['main-frame', 'MM0200329', 'Main Frame'],
      ['adjustment-ring', '1093080129', 'Adjustment Ring'],
      ['clamping-cylinders', '1093070001', 'Clamping cylinders'],
      ['roller-assembly', '1094200192', 'Roller Assembly'],
      ['tramp-release', '1093080005', 'Tramp Release'],
      ['cylinder-assy', '1093070045', 'Cylinder Assy.'],
      ['rod-assy', '1093075008', 'Tramp Rel Rod Assembly'],
      ['piston-rod', '1065634361', 'Piston Rod'],
      ['piston', '10054915521', 'Piston'],
      ['loctite', '1004826361', 'Loctite 262'],
      ['accumulator', '1093085016', 'Accumulator Assy.'],
      ['countershaft-box', '1093080219', 'Countershaft Box'],
      ['eccentric', '1093080217', 'Eccentric'],
      ['socket', '1093080001', 'Socket'],
      ['head', '1093080073', 'Head'],
      ['feed-plate', '1093070190', 'Feed Plate'],
      ['liner', '1093080094', 'Liner'],
      ['bowl', '1093080117', 'Bowl'],
      ['hopper', '1093080128', 'Hopper'],
    ]
    for (const [key, partNumber, descriptionEn] of partRows) {
      partIds[key] = await ensureOemPart(conn, {
        partNumber,
        descriptionEn,
        hasDrawing: ['rod-assy', 'piston-rod', 'piston'].includes(key) ? 1 : 0,
      })
    }

    const byKey = new Map()
    await addBomItem(conn, byKey, 'main-frame', {
      itemNo: '1',
      partNumber: 'MM0200329',
      partName: 'Main Frame',
      oemPartId: partIds['main-frame'],
      quantity: 1,
      sortOrder: 10,
    })
    await addBomItem(conn, byKey, 'adjustment-ring', {
      itemNo: '2',
      partNumber: '1093080129',
      partName: 'Adjustment Ring',
      oemPartId: partIds['adjustment-ring'],
      quantity: 1,
      sortOrder: 20,
    })
    await addBomItem(conn, byKey, 'clamping-cylinders', {
      parentKey: 'adjustment-ring',
      itemNo: '2.1',
      partNumber: '1093070001',
      partName: 'Clamping cylinders',
      oemPartId: partIds['clamping-cylinders'],
      quantity: 1,
      sortOrder: 10,
    })
    await addBomItem(conn, byKey, 'roller-assembly', {
      parentKey: 'adjustment-ring',
      itemNo: '2.2',
      partNumber: '1094200192',
      partName: 'Roller Assembly',
      oemPartId: partIds['roller-assembly'],
      quantity: 1,
      sortOrder: 20,
    })
    await addBomItem(conn, byKey, 'tramp-release', {
      itemNo: '3',
      partNumber: '1093080005',
      partName: 'Tramp Release',
      oemPartId: partIds['tramp-release'],
      quantity: 1,
      sortOrder: 30,
    })
    await addBomItem(conn, byKey, 'cylinder-assy', {
      parentKey: 'tramp-release',
      itemNo: '3.1',
      partNumber: '1093070045',
      partName: 'Cylinder Assy.',
      oemPartId: partIds['cylinder-assy'],
      quantity: 1,
      sortOrder: 10,
    })
    await addBomItem(conn, byKey, 'rod-assy', {
      parentKey: 'tramp-release',
      itemNo: '3.2',
      partNumber: '1093075008',
      partName: 'Tramp Rel Rod Assembly',
      drawingNumber: '11093075008',
      oemPartId: partIds['rod-assy'],
      quantity: 1,
      sortOrder: 20,
    })
    await addBomItem(conn, byKey, 'piston-rod', {
      parentKey: 'rod-assy',
      itemNo: '1',
      partNumber: '1065634361',
      partName: 'Piston Rod',
      oemPartId: partIds['piston-rod'],
      quantity: 1,
      sortOrder: 10,
    })
    await addBomItem(conn, byKey, 'piston', {
      parentKey: 'rod-assy',
      itemNo: '2',
      partNumber: '10054915521',
      partName: 'Piston',
      oemPartId: partIds['piston'],
      quantity: 1,
      sortOrder: 20,
    })
    await addBomItem(conn, byKey, 'loctite', {
      parentKey: 'rod-assy',
      itemNo: '3',
      partNumber: '1004826361',
      partName: 'Loctite 262',
      oemPartId: partIds.loctite,
      quantity: 1,
      sortOrder: 30,
      notes: 'В каталоге количество указано A/R.',
    })
    await addBomItem(conn, byKey, 'accumulator', {
      parentKey: 'tramp-release',
      itemNo: '3.3',
      partNumber: '1093085016',
      partName: 'Accumulator Assy.',
      oemPartId: partIds.accumulator,
      quantity: 1,
      sortOrder: 30,
    })
    await addBomItem(conn, byKey, 'countershaft-box', {
      itemNo: '4',
      partNumber: '1093080219',
      partName: 'Countershaft Box',
      oemPartId: partIds['countershaft-box'],
      quantity: 1,
      sortOrder: 40,
    })
    await addBomItem(conn, byKey, 'eccentric', {
      itemNo: '5',
      partNumber: '1093080217',
      partName: 'Eccentric',
      oemPartId: partIds.eccentric,
      quantity: 1,
      sortOrder: 50,
    })
    await addBomItem(conn, byKey, 'socket', {
      itemNo: '6',
      partNumber: '1093080001',
      partName: 'Socket',
      oemPartId: partIds.socket,
      quantity: 1,
      sortOrder: 60,
    })
    await addBomItem(conn, byKey, 'head', {
      itemNo: '7',
      partNumber: '1093080073',
      partName: 'Head',
      oemPartId: partIds.head,
      quantity: 1,
      sortOrder: 70,
    })
    await addBomItem(conn, byKey, 'feed-plate', {
      parentKey: 'head',
      itemNo: '7.1',
      partNumber: '1093070190',
      partName: 'Feed Plate',
      oemPartId: partIds['feed-plate'],
      quantity: 1,
      sortOrder: 10,
    })
    await addBomItem(conn, byKey, 'liner', {
      parentKey: 'head',
      itemNo: '7.2',
      partNumber: '1093080094',
      partName: 'Liner',
      oemPartId: partIds.liner,
      quantity: 1,
      sortOrder: 20,
    })
    await addBomItem(conn, byKey, 'bowl', {
      itemNo: '8',
      partNumber: '1093080117',
      partName: 'Bowl',
      oemPartId: partIds.bowl,
      quantity: 1,
      sortOrder: 80,
    })
    await addBomItem(conn, byKey, 'hopper', {
      itemNo: '9',
      partNumber: '1093080128',
      partName: 'Hopper',
      oemPartId: partIds.hopper,
      quantity: 1,
      sortOrder: 90,
    })
    await addBomItem(conn, byKey, 'standard-fasteners', {
      itemNo: '10',
      partName: 'Standard fasteners',
      title: 'Крепеж стандартный',
      itemType: 'group',
      quantity: 1,
      sortOrder: 100,
      notes: 'Пример переиспользуемой позиции из классификатора внутри BOM модели.',
    })
    await addBomItem(conn, byKey, 'hex-bolt', {
      parentKey: 'standard-fasteners',
      itemNo: '10.1',
      partNumber: 'METSO-HEX-M20X80',
      partName: 'Hex bolt M20x80 10.9 DIN 931',
      catalogPositionId: BOLT_POSITION_ID,
      quantity: 12,
      sortOrder: 10,
      notes: 'Один и тот же болт из классификатора может иметь разные номера у разных производителей.',
    })

    const uploadRoot = path.join(__dirname, '..', 'uploads', 'equipment-models', String(MODEL_ID))
    const docStat = copyIfExists(PDF_SOURCE, path.join(uploadRoot, 'documents', 'HP800214_215_parts_book.pdf'))
    if (docStat) {
      await conn.execute(
        `INSERT INTO equipment_model_documents
          (equipment_model_id, file_url, file_name, file_type, file_size, description)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          MODEL_ID,
          '/uploads/equipment-models/1/documents/HP800214_215_parts_book.pdf',
          'HP800214_215_parts_book.pdf',
          'application/pdf',
          docStat.size,
          'Parts book Nordberg HP800 HP800214 & HP800215',
        ],
      )
    }
    const imageStat = copyIfExists(COVER_SOURCE, path.join(uploadRoot, 'media', 'hp800_parts_book_cover.png'))
    if (imageStat) {
      await conn.execute(
        `INSERT INTO equipment_model_media
          (equipment_model_id, file_url, file_name, mime_type, file_size, caption, sort_order, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
        [
          MODEL_ID,
          '/uploads/equipment-models/1/media/hp800_parts_book_cover.png',
          'hp800_parts_book_cover.png',
          'image/png',
          imageStat.size,
          'Обложка parts book HP800',
        ],
      )
    }

    await conn.commit()
    console.log('HP 800 training data seeded')
  } catch (err) {
    await conn.rollback()
    console.error(err)
    process.exitCode = 1
  } finally {
    conn.release()
    await db.end()
  }
}

main()
