const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const logActivity = require('../utils/logActivity')
const logFieldDiffs = require('../utils/logFieldDiffs')

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

const sqlValue = (v) => (v === undefined ? null : v)

const ALLOWED_NODE_TYPES = new Set([
  'ROOT',
  'CATEGORY',
  'SUBCATEGORY',
  'EQUIPMENT_TYPE',
  'MANUFACTURER_GROUP',
  'MODEL_GROUP',
])

const buildTree = (rows) => {
  const byId = new Map()
  const roots = []

  rows.forEach((row) => byId.set(row.id, { ...row, children: [] }))
  byId.forEach((node) => {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node)
    } else {
      roots.push(node)
    }
  })

  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0)
      return String(a.name || '').localeCompare(String(b.name || ''), 'ru')
    })
    nodes.forEach((node) => sortNodes(node.children))
  }

  sortNodes(roots)
  return roots
}

router.get('/', async (req, res) => {
  try {
    const q = nz(req.query.q)
    const parentIdRaw = req.query.parent_id
    const nodeType = nz(req.query.node_type)
    const isActiveRaw = req.query.is_active
    const asTree = toBool(req.query.tree)
    const limit = clampLimit(req.query.limit, asTree ? 5000 : 200)

    const where = []
    const params = []

    let sql = `
      SELECT n.*,
             p.name AS parent_name,
             (
               SELECT COUNT(*)
                 FROM equipment_classifier_nodes c
                WHERE c.parent_id = n.id
             ) AS children_count
        FROM equipment_classifier_nodes n
        LEFT JOIN equipment_classifier_nodes p ON p.id = n.parent_id
    `

    if (parentIdRaw !== undefined) {
      if (parentIdRaw === '' || parentIdRaw === 'null') {
        where.push('n.parent_id IS NULL')
      } else {
        const parentId = toId(parentIdRaw)
        if (!parentId) {
          return res.status(400).json({ message: 'Некорректный parent_id' })
        }
        where.push('n.parent_id = ?')
        params.push(parentId)
      }
    }

    if (nodeType) {
      if (!ALLOWED_NODE_TYPES.has(nodeType)) {
        return res.status(400).json({ message: 'Некорректный тип узла' })
      }
      where.push('n.node_type = ?')
      params.push(nodeType)
    }

    if (isActiveRaw !== undefined) {
      where.push('n.is_active = ?')
      params.push(toBool(isActiveRaw) ? 1 : 0)
    }

    if (q) {
      where.push('(n.name LIKE ? OR n.code LIKE ? OR n.notes LIKE ?)')
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += ' ORDER BY n.sort_order ASC, n.name ASC'
    if (!asTree) sql += ` LIMIT ${limit}`

    const [rows] = await db.execute(sql, params)
    res.json(asTree ? buildTree(rows) : rows)
  } catch (err) {
    console.error('GET /equipment-classifier-nodes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [rows] = await db.execute(
      `
      SELECT n.*,
             p.name AS parent_name,
             (
               SELECT COUNT(*)
                 FROM equipment_classifier_nodes c
                WHERE c.parent_id = n.id
             ) AS children_count
        FROM equipment_classifier_nodes n
        LEFT JOIN equipment_classifier_nodes p ON p.id = n.parent_id
       WHERE n.id = ?
      `,
      [id]
    )
    if (!rows.length) return res.status(404).json({ message: 'Узел классификатора не найден' })
    res.json(rows[0])
  } catch (err) {
    console.error('GET /equipment-classifier-nodes/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/:id/workspace', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[node]] = await db.execute(
      `
      SELECT n.*,
             p.name AS parent_name,
             (
               SELECT COUNT(*)
                 FROM equipment_classifier_nodes c
                WHERE c.parent_id = n.id
             ) AS children_count
        FROM equipment_classifier_nodes n
        LEFT JOIN equipment_classifier_nodes p ON p.id = n.parent_id
       WHERE n.id = ?
      `,
      [id]
    )
    if (!node) return res.status(404).json({ message: 'Узел классификатора не найден' })

    const subtreeCte = `
      WITH RECURSIVE subtree AS (
        SELECT id, parent_id, name
        FROM equipment_classifier_nodes
        WHERE id = ?
        UNION ALL
        SELECT c.id, c.parent_id, c.name
        FROM equipment_classifier_nodes c
        JOIN subtree s ON s.id = c.parent_id
      )
    `

    const [subtreeNodes] = await db.execute(
      `
      ${subtreeCte}
      SELECT id, parent_id, name
      FROM subtree
      ORDER BY parent_id, name
      `,
      [id]
    )

    const [manufacturers] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        m.id,
        m.name,
        COUNT(DISTINCT em.id) AS models_count,
        COUNT(DISTINCT ceu.id) AS units_count,
        COUNT(DISTINCT f.oem_part_id) AS oem_parts_count
      FROM equipment_manufacturers m
      JOIN equipment_models em
        ON em.manufacturer_id = m.id
      JOIN subtree s
        ON s.id = em.classifier_node_id
      LEFT JOIN client_equipment_units ceu
        ON ceu.equipment_model_id = em.id
      LEFT JOIN oem_part_model_fitments f
        ON f.equipment_model_id = em.id
      GROUP BY m.id, m.name
      ORDER BY m.name
      `,
      [id]
    )

    const [models] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        em.id,
        em.model_name,
        em.model_code,
        em.notes,
        em.classifier_node_id,
        ecn.name AS classifier_node_name,
        m.id AS manufacturer_id,
        m.name AS manufacturer_name,
        COUNT(DISTINCT ceu.id) AS units_count,
        COUNT(DISTINCT f.oem_part_id) AS oem_parts_count
      FROM equipment_models em
      JOIN subtree s
        ON s.id = em.classifier_node_id
      JOIN equipment_manufacturers m
        ON m.id = em.manufacturer_id
      LEFT JOIN equipment_classifier_nodes ecn
        ON ecn.id = em.classifier_node_id
      LEFT JOIN client_equipment_units ceu
        ON ceu.equipment_model_id = em.id
      LEFT JOIN oem_part_model_fitments f
        ON f.equipment_model_id = em.id
      GROUP BY
        em.id, em.model_name, em.model_code, em.notes, em.classifier_node_id,
        ecn.name, m.id, m.name
      ORDER BY m.name, em.model_name
      `,
      [id]
    )

    const [units] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        ceu.id,
        ceu.client_id,
        ceu.equipment_model_id,
        ceu.serial_number,
        ceu.manufacture_year,
        ceu.site_name,
        ceu.internal_name,
        ceu.status,
        c.company_name AS client_name,
        em.model_name,
        em.model_code,
        m.id AS manufacturer_id,
        m.name AS manufacturer_name
      FROM client_equipment_units ceu
      JOIN equipment_models em
        ON em.id = ceu.equipment_model_id
      JOIN subtree s
        ON s.id = em.classifier_node_id
      JOIN clients c
        ON c.id = ceu.client_id
      JOIN equipment_manufacturers m
        ON m.id = em.manufacturer_id
      ORDER BY c.company_name, m.name, em.model_name, ceu.serial_number, ceu.id
      `,
      [id]
    )

    const [[stats]] = await db.execute(
      `
      ${subtreeCte}
      SELECT
        COUNT(DISTINCT s.id) AS subtree_nodes_count,
        COUNT(DISTINCT em.id) AS models_count,
        COUNT(DISTINCT em.manufacturer_id) AS manufacturers_count,
        COUNT(DISTINCT ceu.id) AS units_count,
        COUNT(DISTINCT f.oem_part_id) AS oem_parts_count
      FROM subtree s
      LEFT JOIN equipment_models em
        ON em.classifier_node_id = s.id
      LEFT JOIN client_equipment_units ceu
        ON ceu.equipment_model_id = em.id
      LEFT JOIN oem_part_model_fitments f
        ON f.equipment_model_id = em.id
      `,
      [id]
    )

    res.json({
      node,
      subtree_nodes: subtreeNodes,
      manufacturers,
      models,
      client_equipment_units: units,
      stats: stats || {},
    })
  } catch (err) {
    console.error('GET /equipment-classifier-nodes/:id/workspace error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.post('/', async (req, res) => {
  try {
    const parent_id =
      req.body.parent_id === undefined || req.body.parent_id === null || req.body.parent_id === ''
        ? null
        : toId(req.body.parent_id)
    const name = nz(req.body.name)
    const node_type = nz(req.body.node_type) || 'CATEGORY'
    const code = nz(req.body.code)
    const sort_order = Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : 0
    const is_active = req.body.is_active === undefined ? 1 : (toBool(req.body.is_active) ? 1 : 0)
    const notes = nz(req.body.notes)

    if (!name) return res.status(400).json({ message: 'name обязателен' })
    if (!ALLOWED_NODE_TYPES.has(node_type)) {
      return res.status(400).json({ message: 'Некорректный тип узла' })
    }
    if (req.body.parent_id !== undefined && req.body.parent_id !== null && req.body.parent_id !== '' && !parent_id) {
      return res.status(400).json({ message: 'Некорректный parent_id' })
    }
    if (parent_id) {
      const [parent] = await db.execute('SELECT id FROM equipment_classifier_nodes WHERE id = ?', [parent_id])
      if (!parent.length) {
        return res.status(400).json({ message: 'Родительский узел не найден' })
      }
    }

    const [ins] = await db.execute(
      `
      INSERT INTO equipment_classifier_nodes
        (parent_id, name, node_type, code, sort_order, is_active, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [parent_id, name, node_type, code, sort_order, is_active, notes]
    )

    const [[created]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [
      ins.insertId,
    ])

    await logActivity({
      req,
      action: 'create',
      entity_type: 'equipment_classifier_nodes',
      entity_id: ins.insertId,
      comment: 'Добавлен узел классификатора оборудования',
    })

    res.status(201).json(created)
  } catch (err) {
    console.error('POST /equipment-classifier-nodes error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Узел классификатора не найден' })

    const parent_id =
      req.body.parent_id === undefined
        ? undefined
        : (req.body.parent_id === null || req.body.parent_id === '' ? null : toId(req.body.parent_id))
    const name = req.body.name !== undefined ? nz(req.body.name) : undefined
    const node_type = req.body.node_type !== undefined ? nz(req.body.node_type) : undefined
    const code = req.body.code !== undefined ? nz(req.body.code) : undefined
    const sort_order =
      req.body.sort_order !== undefined
        ? (Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : null)
        : undefined
    const is_active = req.body.is_active !== undefined ? (toBool(req.body.is_active) ? 1 : 0) : undefined
    const notes = req.body.notes !== undefined ? nz(req.body.notes) : undefined

    if (parent_id !== undefined && req.body.parent_id !== null && req.body.parent_id !== '' && !parent_id) {
      return res.status(400).json({ message: 'Некорректный parent_id' })
    }
    if (parent_id === id) return res.status(400).json({ message: 'Узел не может быть родителем самого себя' })
    if (name !== undefined && !name) return res.status(400).json({ message: 'name не может быть пустым' })
    if (node_type !== undefined && !ALLOWED_NODE_TYPES.has(node_type)) {
      return res.status(400).json({ message: 'Некорректный тип узла' })
    }
    if (sort_order !== undefined && sort_order === null) {
      return res.status(400).json({ message: 'Некорректный sort_order' })
    }
    if (parent_id) {
      const [parent] = await db.execute('SELECT id FROM equipment_classifier_nodes WHERE id = ?', [parent_id])
      if (!parent.length) return res.status(400).json({ message: 'Родительский узел не найден' })
    }

    await db.execute(
      `
      UPDATE equipment_classifier_nodes
         SET parent_id = ?,
             name = COALESCE(?, name),
             node_type = COALESCE(?, node_type),
             code = COALESCE(?, code),
             sort_order = COALESCE(?, sort_order),
             is_active = COALESCE(?, is_active),
             notes = COALESCE(?, notes)
       WHERE id = ?
      `,
      [
        parent_id === undefined ? before.parent_id : parent_id,
        sqlValue(name),
        sqlValue(node_type),
        sqlValue(code),
        sqlValue(sort_order),
        sqlValue(is_active),
        sqlValue(notes),
        id,
      ]
    )

    const [[after]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [id])
    await logFieldDiffs({
      req,
      entity_type: 'equipment_classifier_nodes',
      entity_id: id,
      oldData: before,
      newData: after,
    })

    res.json(after)
  } catch (err) {
    console.error('PUT /equipment-classifier-nodes/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const id = toId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Некорректный идентификатор' })

    const [[before]] = await db.execute('SELECT * FROM equipment_classifier_nodes WHERE id = ?', [id])
    if (!before) return res.status(404).json({ message: 'Узел классификатора не найден' })

    await db.execute('DELETE FROM equipment_classifier_nodes WHERE id = ?', [id])

    await logActivity({
      req,
      action: 'delete',
      entity_type: 'equipment_classifier_nodes',
      entity_id: id,
      comment: `Удалён узел классификатора: ${before.name}`,
    })

    res.json({ success: true })
  } catch (err) {
    if (err && (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED')) {
      return res.status(409).json({
        message: 'Нельзя удалить узел, пока он используется в моделях или дочерних узлах',
      })
    }
    console.error('DELETE /equipment-classifier-nodes/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

module.exports = router
