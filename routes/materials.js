// routes/materials.js
// Справочник материалов + импорт из подготовленного JSON

const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')

const nz = (v) => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

const toId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

const toBool = (v) => v === true || v === '1' || v === 1 || v === 'true'

const clampLimit = (v, def = 200, max = 1000) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.trunc(n), max)
}

const numOrNull = (v) => {
  if (v === '' || v === undefined || v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const normalizePoints = (raw) => {
  if (!Array.isArray(raw)) return []
  const points = []
  for (const p of raw) {
    const x = numOrNull(p?.x ?? p?.[0])
    const y = numOrNull(p?.y ?? p?.[1])
    if (x === null || y === null) continue
    points.push({ x, y })
  }
  return points
}

const buildMatKey = (sourceFile, sourcePath, name) =>
  `${sourceFile || ''}||${sourcePath || ''}||${name || ''}`

const ensureCategory = async (conn, pathParts = [], source = null) => {
  if (!Array.isArray(pathParts) || pathParts.length === 0) return null
  // локальный кэш на время запроса
  const cache = new Map()

  let parentId = null
  for (const rawName of pathParts) {
    const name = nz(rawName)
    if (!name) continue
    const key = `${parentId || 0}::${name}`
    if (cache.has(key)) {
      parentId = cache.get(key)
      continue
    }

    const [found] = await conn.execute(
      `
      SELECT id FROM material_categories
       WHERE name = ?
         AND parent_id <=> ?
       LIMIT 1
      `,
      [name, parentId]
    )
    if (found.length) {
      parentId = found[0].id
      cache.set(key, parentId)
      continue
    }

        try {
          const [ins] = await conn.execute(
            `
            INSERT INTO material_categories (name, parent_id, source)
            VALUES (?, ?, ?)
            `,
            [name, parentId, nz(source)]
          )
          parentId = ins.insertId
          cache.set(key, parentId)
        } catch (e) {
          // параллельная вставка того же пути — пытаемся взять существующий
          const [again] = await conn.execute(
            `SELECT id FROM material_categories WHERE name = ? AND parent_id <=> ? LIMIT 1`,
            [name, parentId]
          )
          if (again.length) {
            parentId = again[0].id
            cache.set(key, parentId)
          } else {
            throw e
          }
        }
      }
      return parentId
    }

// Вспомогательный метод: вставка/обновление свойств/кривых/алиасов
const replacePropsCurvesAliases = async (conn, materialId, payload) => {
  if (Array.isArray(payload.properties)) {
    await conn.execute('DELETE FROM material_properties WHERE material_id = ?', [
      materialId,
    ])
    const props = payload.properties
    if (props.length) {
      const placeholders = []
      const values = []
      for (const p of props) {
        const codeVal = nz(p.code)
        if (!codeVal) continue
        placeholders.push('(?,?,?,?,?,?,?)')
        values.push(
          materialId,
          codeVal,
          nz(p.display_name),
          numOrNull(p.value_num),
          nz(p.value_text),
          nz(p.unit),
          toBool(p.use_curve) ? 1 : 0
        )
      }
      if (placeholders.length) {
        await conn.execute(
          `
          INSERT INTO material_properties
            (material_id, code, display_name, value_num, value_text, unit, use_curve)
          VALUES ${placeholders.join(', ')}
          `,
          values
        )
      }
    }
  }

  if (Array.isArray(payload.curves)) {
    await conn.execute(
      'DELETE FROM material_property_curves WHERE material_id = ?',
      [materialId]
    )
    const curves = payload.curves
    if (curves.length) {
      const placeholders = []
      const values = []
      for (const c of curves) {
        const pts = Array.isArray(c.points) ? c.points : []
        placeholders.push('(?,?,?,?,?)')
        values.push(
          materialId,
          nz(c.curve_id),
          nz(c.name),
          nz(c.type),
          JSON.stringify(pts)
        )
      }
      if (placeholders.length) {
        await conn.execute(
          `
          INSERT INTO material_property_curves
            (material_id, curve_id, name, type, points)
          VALUES ${placeholders.join(', ')}
          `,
          values
        )
      }
    }
  }

  if (Array.isArray(payload.aliases)) {
    await conn.execute('DELETE FROM material_aliases WHERE material_id = ?', [
      materialId,
    ])
    const aliases = payload.aliases
    if (aliases.length) {
      const placeholders = []
      const values = []
      for (const a of aliases) {
        const alias = nz(a.alias || a)
        if (!alias) continue
        placeholders.push('(?,?,?)')
        values.push(materialId, alias, nz(a.source))
      }
      if (placeholders.length) {
        await conn.execute(
          `
          INSERT INTO material_aliases (material_id, alias, source)
          VALUES ${placeholders.join(', ')}
          `,
          values
        )
      }
    }
  }
}

// ------------------------------------------------------------
// Служебный маршрут: восстановление категорий для материалов без category_id
// Берёт source_path (или category_path, если передан в body) и создаёт/привязывает категории
// ------------------------------------------------------------
router.post('/rebuild-categories', async (req, res) => {
  const categoryPathsOverride = req.body?.category_paths || {}

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.execute(
      `SELECT id, source_path FROM materials WHERE category_id IS NULL`
    )

    let fixed = 0
    for (const row of rows) {
      const override = categoryPathsOverride[row.id]
      const pathParts = Array.isArray(override)
        ? override
        : (row.source_path || '')
            .split('/')
            .map((s) => (s || '').trim())
            .filter(Boolean)

      if (!pathParts.length) continue

      const catId = await ensureCategory(conn, pathParts, null)
      if (catId) {
        await conn.execute(
          `UPDATE materials SET category_id = ?, updated_at = NOW() WHERE id = ?`,
          [catId, row.id]
        )
        fixed += 1
      }
    }

    await conn.commit()
    res.json({ message: 'Категории восстановлены', fixed, total: rows.length })
  } catch (err) {
    try {
      await conn.rollback()
    } catch {}
    console.error('POST /materials/rebuild-categories error:', err)
    res.status(500).json({ message: 'Ошибка восстановления категорий' })
  } finally {
    conn?.release()
  }
})

// ------------------------------------------------------------
// GET /materials/categories — плоский список категорий с количеством материалов
// ------------------------------------------------------------
router.get('/categories', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT c.id,
             c.name,
             c.parent_id,
             c.source,
             c.sort_order,
             c.created_at,
             c.updated_at,
             COALESCE(mc.cnt, 0) AS materials_count
        FROM material_categories c
        LEFT JOIN (
          SELECT category_id, COUNT(*) AS cnt
            FROM materials
           GROUP BY category_id
        ) mc ON mc.category_id = c.id
       ORDER BY (c.parent_id IS NULL) DESC, c.parent_id, c.sort_order, c.name
      `
    )
    res.json(rows)
  } catch (err) {
    console.error('GET /materials/categories error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------
// GET /materials — список материалов (фильтр по категории, поиску)
// ------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const categoryId = toId(req.query.category_id)
    // MySQL не любит параметризованные LIMIT/OFFSET в некоторых сборках,
    // поэтому строим литералами после валидации.
    const limitNum = clampLimit(req.query.limit)
    const rawOffset = Number(req.query.offset)
    const offsetNum = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.trunc(rawOffset) : 0

    const where = []
    const params = []

    if (q) {
      where.push(
        '(m.name LIKE ? OR m.code LIKE ? OR m.standard LIKE ? OR m.description LIKE ?)'
      )
      const like = `%${q}%`
      params.push(like, like, like, like)
    }

    if (categoryId) {
      where.push('m.category_id = ?')
      params.push(categoryId)
    }

    let sql = `
      SELECT m.id,
             m.category_id,
             m.name,
             m.code,
             m.standard,
             m.source_file,
             m.source_path,
             m.description,
             m.created_at,
             m.updated_at,
             c.name AS category_name,
             c.parent_id AS category_parent_id
        FROM materials m
        LEFT JOIN material_categories c ON c.id = m.category_id
    `

    if (where.length) {
      sql += ' WHERE ' + where.join(' AND ')
    }

    sql += ` ORDER BY m.name LIMIT ${limitNum} OFFSET ${offsetNum}`

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /materials error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------
// GET /materials/:id — материал c свойствами, кривыми и алиасами
// ------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный id' })

    const [rows] = await db.execute(
      `
      SELECT m.*,
             c.name AS category_name,
             c.parent_id AS category_parent_id
        FROM materials m
        LEFT JOIN material_categories c ON c.id = m.category_id
       WHERE m.id = ?
      `,
      [id]
    )

    if (!rows.length) {
      return res.status(404).json({ message: 'Материал не найден' })
    }

    const material = rows[0]

    const [props] = await db.execute(
      `SELECT id, code, display_name, value_num, value_text, unit, use_curve
         FROM material_properties
        WHERE material_id = ?
        ORDER BY code`,
      [id]
    )

    const [curves] = await db.execute(
      `SELECT id, curve_id, name, type, points
         FROM material_property_curves
        WHERE material_id = ?
        ORDER BY id`,
      [id]
    )

    const [aliases] = await db.execute(
      `SELECT id, alias, source
         FROM material_aliases
        WHERE material_id = ?
        ORDER BY alias`,
      [id]
    )

    material.properties = props
    material.curves = curves.map((c) => ({
      ...c,
      points:
        typeof c.points === 'string'
          ? JSON.parse(c.points || '[]')
          : c.points || [],
    }))
    material.aliases = aliases

    res.json(material)
  } catch (err) {
    console.error('GET /materials/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ------------------------------------------------------------
// CREATE материал вручную
// body: { name, code?, standard?, description?, source_file?, source_path?, category_id?, category_path?, properties?, curves?, aliases? }
// ------------------------------------------------------------
router.post('/', async (req, res) => {
  const payload = req.body || {}
  const name = nz(payload.name)
  if (!name) {
    return res.status(400).json({ message: 'Поле name обязательно' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const categoryId =
      toId(payload.category_id) ||
      (await ensureCategory(conn, payload.category_path, payload.source_file))

    const [ins] = await conn.execute(
      `
      INSERT INTO materials (category_id, name, code, standard, source_file, source_path, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        categoryId,
        name,
        nz(payload.code),
        nz(payload.standard),
        nz(payload.source_file),
        nz(payload.source_path),
        nz(payload.description),
      ]
    )

    await replacePropsCurvesAliases(conn, ins.insertId, payload)
    await conn.commit()

    const [rows] = await conn.execute(
      `
      SELECT m.*, c.name AS category_name, c.parent_id AS category_parent_id
        FROM materials m
        LEFT JOIN material_categories c ON c.id = m.category_id
       WHERE m.id = ?
      `,
      [ins.insertId]
    )

    await logActivity({
      req,
      action: 'create',
      entity_type: 'materials',
      entity_id: ins.insertId,
      comment: 'Создан материал вручную',
    })

    res.status(201).json(rows[0])
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('POST /materials error:', err)
    res.status(500).json({ message: 'Ошибка создания материала' })
  } finally {
    conn?.release()
  }
})

// ------------------------------------------------------------
// UPDATE материал
// body: те же поля, properties/curves/aliases — если массив, то заменяем; если не переданы, оставляем как есть
// ------------------------------------------------------------
router.put('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный id' })

  const payload = req.body || {}
  const name = nz(payload.name)
  if (!name) {
    return res.status(400).json({ message: 'Поле name обязательно' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [exists] = await conn.execute(
      'SELECT * FROM materials WHERE id = ?',
      [id]
    )
    if (!exists.length) {
      await conn.rollback()
      return res.status(404).json({ message: 'Материал не найден' })
    }

    const categoryId =
      toId(payload.category_id) ||
      (await ensureCategory(conn, payload.category_path, payload.source_file))

    await conn.execute(
      `
      UPDATE materials
         SET category_id = ?,
             name = ?,
             code = ?,
             standard = ?,
             source_file = ?,
             source_path = ?,
             description = ?,
             updated_at = NOW()
       WHERE id = ?
      `,
      [
        categoryId,
        name,
        nz(payload.code),
        nz(payload.standard),
        nz(payload.source_file),
        nz(payload.source_path),
        nz(payload.description),
        id,
      ]
    )

    await replacePropsCurvesAliases(conn, id, payload)
    await conn.commit()

    const [rows] = await conn.execute(
      `
      SELECT m.*, c.name AS category_name, c.parent_id AS category_parent_id
        FROM materials m
        LEFT JOIN material_categories c ON c.id = m.category_id
       WHERE m.id = ?
      `,
      [id]
    )

    await logActivity({
      req,
      action: 'update',
      entity_type: 'materials',
      entity_id: id,
      comment: 'Материал обновлён вручную',
    })

    res.json(rows[0])
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch {}
    }
    console.error('PUT /materials/:id error:', err)
    res.status(500).json({ message: 'Ошибка обновления материала' })
  } finally {
    conn?.release()
  }
})

// ------------------------------------------------------------
// DELETE материал
// ------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id)
  if (!id) return res.status(400).json({ message: 'Некорректный id' })

  try {
    const [exists] = await db.execute('SELECT * FROM materials WHERE id = ?', [id])
    if (!exists.length) {
      return res.status(404).json({ message: 'Материал не найден' })
    }

    await db.execute('DELETE FROM materials WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'materials',
      entity_id: id,
      comment: `Материал "${exists[0].name}" удалён`,
    })

    res.json({ message: 'Материал удалён' })
  } catch (err) {
    console.error('DELETE /materials/:id error:', err)
    res.status(500).json({ message: 'Ошибка удаления материала' })
  }
})

// ------------------------------------------------------------
// POST /materials/import
// Ожидает JSON:
// {
//   categories?: [{ path: ["Сталь", "Нержавеющая"], source?: "solidworks" }],
//   materials: [{
//     name: "...", code?, standard?, description?, source_file?, source_path?,
//     category_id? or category_path?: ["..."],
//     properties?: [{ code, display_name, value_num?, value_text?, unit?, use_curve? }],
//     curves?: [{ curve_id?, name?, type?, points: [{x,y}, ...] }],
//     aliases?: [ "AISI 304", ... ]
//   }],
//   truncate?: true // опционально: очистить таблицы перед импортом
// }
// ------------------------------------------------------------
router.post('/import', async (req, res) => {
  const payload = req.body || {}
  const categoriesInput = Array.isArray(payload.categories)
    ? payload.categories
    : []
  const materialsInput = Array.isArray(payload.materials)
    ? payload.materials
    : []
  const truncate = toBool(payload.truncate || req.query.truncate)

  if (!materialsInput.length) {
    return res.status(400).json({ message: 'Нет данных для импорта (materials)' })
  }

  if (materialsInput.length > 10000) {
    return res.status(413).json({ message: 'Слишком много материалов (макс 10000)' })
  }

  // debug: выводим первые пути категорий, чтобы понять, что пришло
  if (process.env.DEBUG_MATERIALS_IMPORT === '1') {
    console.log('materials sample', materialsInput.slice(0, 3).map(m => ({
      name: m?.name,
      category_path: m?.category_path,
      source_path: m?.source_path,
    })))
    console.log('categories sample', categoriesInput.slice(0,3))
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    if (truncate) {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0')
      await conn.query('TRUNCATE material_property_curves')
      await conn.query('TRUNCATE material_properties')
      await conn.query('TRUNCATE material_aliases')
      await conn.query('TRUNCATE materials')
      await conn.query('TRUNCATE material_categories')
      await conn.query('SET FOREIGN_KEY_CHECKS = 1')
    }

    // Кэш категорий по ключу parentId::name
    const categoryCache = new Map()
    if (!truncate) {
      const [existingCats] = await conn.execute(
        'SELECT id, name, parent_id FROM material_categories'
      )
      for (const c of existingCats) {
        const key = `${c.parent_id || 0}::${c.name}`
        categoryCache.set(key, c.id)
      }
    }

    const ensureCategory = async (pathParts = [], source = null) => {
      if (!Array.isArray(pathParts) || pathParts.length === 0) return null
      let parentId = null
      for (const rawName of pathParts) {
        const name = nz(rawName)
        if (!name) continue
        const key = `${parentId || 0}::${name}`
        if (categoryCache.has(key)) {
          parentId = categoryCache.get(key)
          continue
        }

        const [found] = await conn.execute(
          `
          SELECT id FROM material_categories
           WHERE name = ?
             AND parent_id <=> ?
           LIMIT 1
          `,
          [name, parentId]
        )
        if (found.length) {
          parentId = found[0].id
          categoryCache.set(key, parentId)
          continue
        }

        const [ins] = await conn.execute(
          `
          INSERT INTO material_categories (name, parent_id, source)
          VALUES (?, ?, ?)
          `,
          [name, parentId, nz(source)]
        )
        parentId = ins.insertId
        categoryCache.set(key, parentId)
      }
      return parentId
    }

    // Создаём категории из payload.categories, если переданы
    let categoriesCreated = 0
    for (const cat of categoriesInput) {
      const targetId = await ensureCategory(cat.path || cat.category_path, cat.source)
      if (targetId) categoriesCreated += 1
    }

    // Кэш существующих материалов по ключу (source_file|source_path|name)
    const existingMaterials = new Map()
    if (!truncate) {
      const [matRows] = await conn.execute(
        'SELECT id, name, source_file, source_path FROM materials'
      )
      for (const r of matRows) {
        existingMaterials.set(
          buildMatKey(r.source_file, r.source_path, r.name),
          r.id
        )
      }
    }

    let inserted = 0
    let updated = 0
    let propsInserted = 0
    let curvesInserted = 0
    let aliasesInserted = 0

    for (const raw of materialsInput) {
      const name = nz(raw.name)
      if (!name) continue

      let categoryId = toId(raw.category_id)
      let categoryPath = Array.isArray(raw.category_path)
        ? raw.category_path
        : nz(raw.source_path)
        ? String(raw.source_path).split('/').map((s) => s.trim()).filter(Boolean)
        : []
      if ((!categoryPath || categoryPath.length === 0) && nz(raw.source_file)) {
        categoryPath = [nz(raw.source_file)]
      }
      if (!categoryId) {
        categoryId = await ensureCategory(categoryPath, raw.source_file)
      }

      const sourceFile = nz(raw.source_file)
      const sourcePath = nz(
        raw.source_path ||
          (Array.isArray(raw.category_path)
            ? raw.category_path.join(' / ')
            : null)
      )
      const code = nz(raw.code)

      let standard = null
      let description = nz(raw.description)
      if (nz(raw.standard)) {
        const stdStr = String(raw.standard)
        if (stdStr.length > 64) {
          // длинный стандарт пишем целиком в описание, а в стандарт — обрезку
          description = [description || '', stdStr].filter(Boolean).join('\n').trim()
          standard = stdStr.slice(0, 64)
        } else {
          standard = stdStr
        }
      }

      const key = buildMatKey(sourceFile, sourcePath, name)
      let materialId = existingMaterials.get(key)

      if (materialId) {
        await conn.execute(
          `
          UPDATE materials
             SET category_id = ?,
                 code = ?,
                 standard = ?,
                 source_file = ?,
                 source_path = ?,
                 description = ?,
                 updated_at = NOW()
           WHERE id = ?
          `,
          [categoryId, code, standard, sourceFile, sourcePath, description, materialId]
        )
        updated += 1
      } else {
        const [ins] = await conn.execute(
          `
          INSERT INTO materials (category_id, name, code, standard, source_file, source_path, description)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [categoryId, name, code, standard, sourceFile, sourcePath, description]
        )
        materialId = ins.insertId
        existingMaterials.set(key, materialId)
        inserted += 1
      }

      // Свойства
      await conn.execute('DELETE FROM material_properties WHERE material_id = ?', [
        materialId,
      ])

      const props = Array.isArray(raw.properties) ? raw.properties : []
      if (props.length) {
        const placeholders = []
        const values = []
        for (const p of props) {
          const codeVal = nz(p.code)
          if (!codeVal) continue
          placeholders.push('(?,?,?,?,?,?,?)')
          values.push(
            materialId,
            codeVal,
            nz(p.display_name),
            numOrNull(p.value_num),
            nz(p.value_text),
            nz(p.unit),
            toBool(p.use_curve) ? 1 : 0
          )
          propsInserted += 1
        }
        if (placeholders.length) {
          await conn.execute(
            `
            INSERT INTO material_properties
              (material_id, code, display_name, value_num, value_text, unit, use_curve)
            VALUES ${placeholders.join(', ')}
            `,
            values
          )
        }
      }

      // Кривые
      await conn.execute(
        'DELETE FROM material_property_curves WHERE material_id = ?',
        [materialId]
      )

      const curves = Array.isArray(raw.curves) ? raw.curves : []
      if (curves.length) {
        const placeholders = []
        const values = []
        for (const c of curves) {
          const pts = normalizePoints(c.points)
          placeholders.push('(?,?,?,?,?)')
          values.push(
            materialId,
            nz(c.curve_id),
            nz(c.name),
            nz(c.type),
            JSON.stringify(pts)
          )
          curvesInserted += 1
        }
        if (placeholders.length) {
          await conn.execute(
            `
            INSERT INTO material_property_curves
              (material_id, curve_id, name, type, points)
            VALUES ${placeholders.join(', ')}
            `,
            values
          )
        }
      }

      // Алиасы
      await conn.execute('DELETE FROM material_aliases WHERE material_id = ?', [
        materialId,
      ])
      const aliases = Array.isArray(raw.aliases) ? raw.aliases : []
      if (aliases.length) {
        const placeholders = []
        const values = []
        for (const alias of aliases) {
          const a = nz(alias)
          if (!a) continue
          placeholders.push('(?,?,?)')
          values.push(materialId, a, nz(raw.source_file))
          aliasesInserted += 1
        }
        if (placeholders.length) {
          await conn.execute(
            `
            INSERT INTO material_aliases (material_id, alias, source)
            VALUES ${placeholders.join(', ')}
            `,
            values
          )
        }
      }
    }

    await conn.commit()

    res.json({
      message: 'Импорт завершён',
      inserted,
      updated,
      categoriesCreated,
      propertiesInserted: propsInserted,
      curvesInserted,
      aliasesInserted,
      truncate,
    })
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback()
      } catch (rollbackErr) {
        console.error('Rollback error in /materials/import:', rollbackErr)
      }
    }
    console.error('POST /materials/import error:', err)
    res.status(500).json({ message: 'Ошибка сервера при импорте материалов' })
  } finally {
    if (conn) conn.release()
  }
})

module.exports = router
