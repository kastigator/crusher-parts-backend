const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const { buildTrashPreview } = require('../utils/trashPreview')
const { buildRestorePreview, restoreTrashEntry } = require('../utils/trashRestore')

router.get('/', async (req, res) => {
  try {
    const params = []
    const where = []

    const status = req.query.status ? String(req.query.status).trim() : 'pending'
    if (status) {
      where.push('te.restore_status = ?')
      params.push(status)
    }

    const entityType = req.query.entity_type ? String(req.query.entity_type).trim() : null
    if (entityType) {
      where.push('te.entity_type = ?')
      params.push(entityType)
    }

    const deleteMode = req.query.delete_mode ? String(req.query.delete_mode).trim() : null
    if (deleteMode) {
      where.push('te.delete_mode = ?')
      params.push(deleteMode)
    }

    const limitRaw = Number(req.query.limit)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 200) : 100

    let sql = `
      SELECT
        te.id,
        te.entity_type,
        te.entity_id,
        te.root_entity_type,
        te.root_entity_id,
        te.delete_mode,
        te.title,
        te.subtitle,
        te.deleted_at,
        te.purge_after_at,
        te.restore_status,
        te.restored_at,
        u.full_name AS deleted_by_name,
        COUNT(tei.id) AS item_count
      FROM trash_entries te
      LEFT JOIN users u ON u.id = te.deleted_by_user_id
      LEFT JOIN trash_entry_items tei ON tei.trash_entry_id = te.id
    `
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`
    sql += `
      GROUP BY
        te.id, te.entity_type, te.entity_id, te.root_entity_type, te.root_entity_id,
        te.delete_mode, te.title, te.subtitle, te.deleted_at, te.purge_after_at,
        te.restore_status, te.restored_at, u.full_name
      ORDER BY te.deleted_at DESC, te.id DESC
      LIMIT ${limit}
    `

    const [rows] = await db.execute(sql, params)
    res.json(rows)
  } catch (err) {
    console.error('GET /trash error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке корзины' })
  }
})

router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: 'Некорректный идентификатор корзины' })
    }

    const [[entry]] = await db.execute(
      `
      SELECT
        te.*,
        u.full_name AS deleted_by_name,
        ru.full_name AS restored_by_name
      FROM trash_entries te
      LEFT JOIN users u ON u.id = te.deleted_by_user_id
      LEFT JOIN users ru ON ru.id = te.restored_by_user_id
      WHERE te.id = ?
      `,
      [id]
    )

    if (!entry) {
      return res.status(404).json({ message: 'Запись корзины не найдена' })
    }

    const [items] = await db.execute(
      `
      SELECT
        id,
        trash_entry_id,
        item_type,
        item_id,
        item_role,
        title,
        snapshot_json,
        sort_order
      FROM trash_entry_items
      WHERE trash_entry_id = ?
      ORDER BY sort_order ASC, id ASC
      `,
      [id]
    )

    res.json({
      ...entry,
      items,
    })
  } catch (err) {
    console.error('GET /trash/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера при загрузке записи корзины' })
  }
})

router.get('/preview/:entityType/:id', async (req, res) => {
  try {
    const preview = await buildTrashPreview(req.params.entityType, req.params.id, req.query || {})
    if (!preview) {
      return res.status(404).json({ message: 'Сущность не найдена' })
    }
    res.json(preview)
  } catch (err) {
    const code = err.status || 500
    if (code < 500) {
      return res.status(code).json({ message: err.message })
    }
    console.error('GET /trash/preview/:entityType/:id error:', err)
    res.status(500).json({ message: 'Ошибка сервера при построении preview корзины' })
  }
})

router.get('/:id/restore-preview', async (req, res) => {
  try {
    const preview = await buildRestorePreview(req.params.id)
    res.json(preview)
  } catch (err) {
    const code = err.status || 500
    if (code < 500) {
      return res.status(code).json({ message: err.message })
    }
    console.error('GET /trash/:id/restore-preview error:', err)
    res.status(500).json({ message: 'Ошибка сервера при построении preview восстановления' })
  }
})

router.post('/:id/restore', async (req, res) => {
  try {
    const entry = await restoreTrashEntry(req.params.id, req)
    res.json({
      success: true,
      trash_entry_id: Number(req.params.id),
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
    })
  } catch (err) {
    const code = err.status || 500
    if (code < 500) {
      return res.status(code).json({ message: err.message })
    }
    console.error('POST /trash/:id/restore error:', err)
    res.status(500).json({ message: 'Ошибка сервера при восстановлении из корзины' })
  }
})

module.exports = router
