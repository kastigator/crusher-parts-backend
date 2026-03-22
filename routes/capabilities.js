const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const { ROLE_CAPABILITY_PRESETS } = require('../utils/capabilityModel')

router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT id, capability_key, name, description, section, sort_order, is_active
      FROM capabilities
      WHERE is_active = 1
      ORDER BY sort_order, id
      `
    )
    res.json(rows)
  } catch (err) {
    console.error('Ошибка при получении capabilities:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.get('/matrix', async (_req, res) => {
  try {
    const [roles] = await db.execute(
      'SELECT id, name, slug FROM roles ORDER BY id'
    )
    const [capabilities] = await db.execute(
      `
      SELECT id, capability_key, name, description, section, sort_order, is_active
      FROM capabilities
      WHERE is_active = 1
      ORDER BY sort_order, id
      `
    )
    const [assignments] = await db.execute(
      'SELECT role_id, capability_id, is_allowed FROM role_capabilities WHERE is_allowed = 1'
    )
    res.json({
      roles,
      capabilities,
      assignments,
      presets: ROLE_CAPABILITY_PRESETS,
    })
  } catch (err) {
    console.error('Ошибка при получении матрицы capabilities:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

router.put('/matrix', async (req, res) => {
  const assignments = req.body
  if (!Array.isArray(assignments)) {
    return res.status(400).json({ message: 'Ожидается массив assignments' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    for (const item of assignments) {
      const roleId = Number(item.role_id)
      const capabilityId = Number(item.capability_id)
      const isAllowed = item.is_allowed ? 1 : 0

      if (!Number.isInteger(roleId) || !Number.isInteger(capabilityId)) {
        await conn.rollback()
        return res.status(400).json({ message: 'Некорректный формат assignments' })
      }

      await conn.execute(
        'DELETE FROM role_capabilities WHERE role_id = ? AND capability_id = ?',
        [roleId, capabilityId]
      )

      if (isAllowed) {
        await conn.execute(
          'INSERT INTO role_capabilities (role_id, capability_id, is_allowed) VALUES (?, ?, 1)',
          [roleId, capabilityId]
        )
      }
    }

    await conn.commit()
    res.json({ message: 'Capabilities сохранены' })
  } catch (err) {
    await conn.rollback()
    console.error('Ошибка при сохранении capabilities:', err)
    res.status(500).json({ message: 'Ошибка при сохранении capabilities' })
  } finally {
    conn.release()
  }
})

router.put('/presets/:roleSlug', async (req, res) => {
  const roleSlug = String(req.params.roleSlug || '').toLowerCase()
  const presetKeys = ROLE_CAPABILITY_PRESETS[roleSlug]

  if (!presetKeys) {
    return res.status(404).json({ message: 'Для этой роли нет capability-пресета' })
  }

  const conn = await db.getConnection()
  try {
    await conn.beginTransaction()

    const [[roleRow]] = await conn.execute('SELECT id FROM roles WHERE slug = ?', [roleSlug])
    if (!roleRow) {
      await conn.rollback()
      return res.status(404).json({ message: 'Роль не найдена' })
    }

    const placeholders = presetKeys.map(() => '?').join(',')
    const [capabilityRows] = presetKeys.length
      ? await conn.execute(
          `SELECT id, capability_key FROM capabilities WHERE is_active = 1 AND capability_key IN (${placeholders})`,
          presetKeys
        )
      : [[]]

    await conn.execute('DELETE FROM role_capabilities WHERE role_id = ?', [roleRow.id])
    for (const capability of capabilityRows) {
      await conn.execute(
        'INSERT INTO role_capabilities (role_id, capability_id, is_allowed) VALUES (?, ?, 1)',
        [roleRow.id, capability.id]
      )
    }

    await conn.commit()
    res.json({
      message: 'Capability-пресет применен',
      role_slug: roleSlug,
      applied_capabilities: capabilityRows.map((row) => row.capability_key),
    })
  } catch (err) {
    await conn.rollback()
    console.error('Ошибка при применении capability-пресета:', err)
    res.status(500).json({ message: 'Ошибка при применении capability-пресета' })
  } finally {
    conn.release()
  }
})

module.exports = router
