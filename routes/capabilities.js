const express = require('express')
const router = express.Router()
const db = require('../utils/db')
const {
  CAPABILITY_DEFINITIONS,
  ROLE_CAPABILITY_PRESETS,
  buildPresetApplicationPlan,
} = require('../utils/capabilityModel')
const { recordSecurityEvent } = require('../services/securityAuditService')

router.get('/', async (_req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT id, capability_key, name, description, section, sort_order, is_active, is_legacy
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
      SELECT id, capability_key, name, description, section, sort_order, is_active, is_legacy
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

      const [[previous]] = await conn.execute(
        'SELECT is_allowed FROM role_capabilities WHERE role_id = ? AND capability_id = ?',
        [roleId, capabilityId]
      )

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

      await recordSecurityEvent({
        executor: conn,
        eventType: 'administration.role_capability_changed',
        actorUserId: req.user.id,
        entityType: 'role',
        entityId: roleId,
        before: { capability_id: capabilityId, is_allowed: Number(previous?.is_allowed) === 1 },
        after: { capability_id: capabilityId, is_allowed: Boolean(isAllowed) },
      })
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

    const [activeCapabilityRows] = await conn.execute(
      'SELECT id, capability_key FROM capabilities WHERE is_active = 1 ORDER BY capability_key'
    )
    const plan = buildPresetApplicationPlan({
      activeCapabilityKeys: activeCapabilityRows.map((row) => row.capability_key),
      presetKeys,
      definitionKeys: CAPABILITY_DEFINITIONS.map((item) => item.key),
    })
    if (!plan.ok) {
      await conn.rollback()
      return res.status(409).json({
        code: 'CAPABILITY_CATALOG_DRIFT',
        message: 'Capability-пресет не применен: каталог кода и активная схема расходятся',
        details: {
          active_missing_from_code: plan.activeMissingFromCode,
          code_missing_from_database: plan.codeMissingFromDatabase,
          preset_missing_from_database: plan.presetMissingFromDatabase,
          duplicate_definition_keys: plan.duplicateDefinitionKeys,
          duplicate_preset_keys: plan.duplicatePresetKeys,
        },
      })
    }

    const placeholders = presetKeys.map(() => '?').join(',')
    const [capabilityRows] = presetKeys.length
      ? await conn.execute(
          `SELECT id, capability_key FROM capabilities WHERE is_active = 1 AND capability_key IN (${placeholders})`,
          presetKeys
        )
      : [[]]

    await conn.execute(
      `DELETE rc
         FROM role_capabilities rc
         JOIN capabilities c ON c.id = rc.capability_id
        WHERE rc.role_id = ?
          AND c.is_active = 1`,
      [roleRow.id]
    )
    for (const capability of capabilityRows) {
      await conn.execute(
        'INSERT INTO role_capabilities (role_id, capability_id, is_allowed) VALUES (?, ?, 1)',
        [roleRow.id, capability.id]
      )
    }

    await recordSecurityEvent({
      executor: conn,
      eventType: 'administration.role_capability_template_applied',
      actorUserId: req.user.id,
      entityType: 'role',
      entityId: roleRow.id,
      after: { role_slug: roleSlug, capability_keys: capabilityRows.map((row) => row.capability_key) },
    })

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
