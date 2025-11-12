// routes/tabs.js
const express = require('express')
const router = express.Router()
const db = require('../utils/db')

const auth = require('../middleware/authMiddleware')
const adminOnly = require('../middleware/adminOnly')

// ------------------------------
// helpers
// ------------------------------
const nz = (v) =>
  v === undefined || v === null ? null : ('' + v).trim() || null

const toInt = (v) => {
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

const normPath = (v) => {
  const s = nz(v)
  if (!s) return null
  // убираем пробелы, приводим к нижнему регистру, гарантируем ведущий слеш
  let p = s.replace(/\s+/g, '')
  if (!p.startsWith('/')) p = '/' + p
  return p.toLowerCase()
}

const normIcon = (v) => {
  const s = nz(v)
  return s || null
}

const assert = (cond, msg, code = 400) => {
  if (!cond) {
    const e = new Error(msg)
    e.status = code
    throw e
  }
}

// Глобально требуем авторизацию
router.use(auth)

/* -------------------------------------------
 * GET /tabs — список (c учётом прав доступа)
 * админ видит всё; не-админ — только can_view=1
 * ------------------------------------------- */
router.get('/', async (req, res) => {
  try {
    const isAdmin = !!req.user?.is_admin
    const roleId = toInt(req.user?.role_id)

    if (isAdmin) {
      const [rows] = await db.execute(
        'SELECT * FROM tabs ORDER BY sort_order ASC, id ASC'
      )
      return res.json(rows)
    }

    assert(roleId !== null, 'Роль пользователя не определена', 403)

    const [rows] = await db.execute(
      `
      SELECT t.*
      FROM tabs t
      JOIN role_permissions rp
        ON rp.tab_id = t.id
       AND rp.role_id = ?
       AND rp.can_view = 1
      ORDER BY t.sort_order ASC, t.id ASC
      `,
      [roleId]
    )
    res.json(rows)
  } catch (err) {
    const code = err.status || 500
    if (code !== 500) {
      return res.status(code).json({ message: err.message })
    }
    console.error('Ошибка получения вкладок:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* --------------------------------------------------
 * PUT /tabs/order — атомарное изменение порядка (admin)
 * ожидаем: [{ id, sort_order }, ...]
 * -------------------------------------------------- */
router.put('/order', adminOnly, async (req, res) => {
  const updates = req.body
  try {
    assert(Array.isArray(updates), 'Ожидается массив')

    for (const item of updates) {
      assert(
        typeof item?.id === 'number' && typeof item?.sort_order === 'number',
        'Элементы должны содержать числовые поля id и sort_order'
      )
    }

    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()

      // Проверим, что все id существуют
      const ids = updates.map((u) => u.id)
      if (ids.length > 0) {
        const [existRows] = await conn.query(
          `SELECT id FROM tabs WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids
        )
        assert(
          existRows.length === ids.length,
          'Передан неизвестный id вкладки',
          400
        )
      }

      for (const { id, sort_order } of updates) {
        await conn.execute('UPDATE tabs SET sort_order = ? WHERE id = ?', [
          sort_order,
          id,
        ])
      }

      await conn.commit()
      res.sendStatus(200)
    } catch (e) {
      try { await conn.rollback() } catch (_) {}
      throw e
    } finally {
      conn.release()
    }
  } catch (err) {
    const code = err.status || 500
    if (code !== 500) {
      return res.status(code).json({ message: err.message })
    }
    console.error('❌ Ошибка обновления порядка вкладок:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ----------------------------------------------
 * POST /tabs — создать (admin)
 * body: { name, tab_name, path, icon? }
 * ---------------------------------------------- */
router.post('/', adminOnly, async (req, res) => {
  try {
    const name = nz(req.body?.name)
    const tab_name = nz(req.body?.tab_name)
    const path = normPath(req.body?.path)
    const icon = normIcon(req.body?.icon)

    assert(name, 'Поле "name" обязательно')
    assert(tab_name, 'Поле "tab_name" обязательно')
    assert(path, 'Поле "path" обязательно')

    // Проверки на уникальность (если нет UNIQUE в БД)
    const [[{ cntPath }]] = await db.execute(
      'SELECT COUNT(*) AS cntPath FROM tabs WHERE path = ?',
      [path]
    )
    assert(cntPath === 0, 'Вкладка с таким path уже существует', 409)

    const [[{ cntTab }]] = await db.execute(
      'SELECT COUNT(*) AS cntTab FROM tabs WHERE tab_name = ?',
      [tab_name]
    )
    assert(cntTab === 0, 'Вкладка с таким tab_name уже существует', 409)

    const [[{ maxOrder }]] = await db.execute(
      'SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM tabs'
    )
    const sort_order = (maxOrder ?? 0) + 1

    const [ins] = await db.execute(
      'INSERT INTO tabs (name, tab_name, path, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
      [name, tab_name, path, icon, sort_order]
    )

    const [rows] = await db.execute('SELECT * FROM tabs WHERE id = ?', [
      ins.insertId,
    ])
    res.status(201).json(rows[0])
  } catch (err) {
    const code = err.status || 500
    if (code !== 500) {
      return res.status(code).json({ message: err.message })
    }
    console.error('Ошибка добавления вкладки:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ---------------------------------------------------------
 * PUT /tabs/:id — обновить (admin)
 * body: { name?, tab_name?, path?, icon?, sort_order? }
 * --------------------------------------------------------- */
router.put('/:id', adminOnly, async (req, res) => {
  try {
    const id = toInt(req.params.id)
    assert(id !== null, 'Некорректный id')

    const name = req.body?.name !== undefined ? nz(req.body.name) : undefined
    const tab_name =
      req.body?.tab_name !== undefined ? nz(req.body.tab_name) : undefined
    const path = req.body?.path !== undefined ? normPath(req.body.path) : undefined
    const icon = req.body?.icon !== undefined ? normIcon(req.body.icon) : undefined
    const sort_order =
      req.body?.sort_order !== undefined ? toInt(req.body.sort_order) : undefined

    // Проверка существования
    const [oldRows] = await db.execute('SELECT * FROM tabs WHERE id = ?', [id])
    assert(oldRows.length > 0, 'Вкладка не найдена', 404)
    const old = oldRows[0]

    // Проверки уникальности, если меняем ключевые поля
    if (path !== undefined && path !== old.path) {
      assert(path, 'Поле "path" не может быть пустым')
      const [[{ cnt }]] = await db.execute(
        'SELECT COUNT(*) AS cnt FROM tabs WHERE path = ? AND id <> ?',
        [path, id]
      )
      assert(cnt === 0, 'Вкладка с таким path уже существует', 409)
    }
    if (tab_name !== undefined && tab_name !== old.tab_name) {
      assert(tab_name, 'Поле "tab_name" не может быть пустым')
      const [[{ cnt }]] = await db.execute(
        'SELECT COUNT(*) AS cnt FROM tabs WHERE tab_name = ? AND id <> ?',
        [tab_name, id]
      )
      assert(cnt === 0, 'Вкладка с таким tab_name уже существует', 409)
    }

    await db.execute(
      `UPDATE tabs
          SET name = COALESCE(?, name),
              tab_name = COALESCE(?, tab_name),
              path = COALESCE(?, path),
              icon = COALESCE(?, icon),
              sort_order = COALESCE(?, sort_order)
        WHERE id = ?`,
      [name, tab_name, path, icon, sort_order, id]
    )

    const [fresh] = await db.execute('SELECT * FROM tabs WHERE id = ?', [id])
    res.json(fresh[0])
  } catch (err) {
    const code = err.status || 500
    if (code !== 500) {
      return res.status(code).json({ message: err.message })
    }
    console.error('❌ Ошибка обновления вкладки:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

/* ------------------------------------------------------
 * DELETE /tabs/:id — удалить вкладку и связанные права (admin)
 * ------------------------------------------------------ */
router.delete('/:id', adminOnly, async (req, res) => {
  let conn
  try {
    const id = toInt(req.params.id)
    assert(id !== null, 'Некорректный id')

    conn = await db.getConnection()
    await conn.beginTransaction()

    // проверим наличие
    const [exists] = await conn.execute('SELECT * FROM tabs WHERE id = ?', [id])
    assert(exists.length > 0, 'Вкладка не найдена', 404)

    // чистим права и удаляем вкладку
    await conn.execute('DELETE FROM role_permissions WHERE tab_id = ?', [id])
    const [del] = await conn.execute('DELETE FROM tabs WHERE id = ?', [id])

    assert(del.affectedRows > 0, 'Вкладка не найдена', 404)

    await conn.commit()
    res.status(200).json({ message: 'Вкладка и связанные права удалены' })
  } catch (err) {
    if (conn) {
      try { await conn.rollback() } catch (_) {}
    }
    const code = err.status || 500
    if (code !== 500) {
      return res.status(code).json({ message: err.message })
    }
    console.error('Ошибка удаления вкладки:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  } finally {
    if (conn) {
      try { conn.release() } catch (_) {}
    }
  }
})

module.exports = router
