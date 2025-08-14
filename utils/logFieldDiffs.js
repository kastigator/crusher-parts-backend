// utils/logFieldDiffs.js
const logActivity = require('./logActivity')

/**
 * Логирование поминутных диффов полей.
 *
 * Поддерживаем две сигнатуры:
 * 1) logFieldDiffs({ req, oldData, newData, entity_type, entity_id, comment?, excludeFields? })
 * 2) logFieldDiffs(conn, { req, before, after, entity_type, entity_id, comment?, excludeFields? })
 *    (conn сейчас используется только для совместимости с импортом; транзакция не прокидывается в logActivity)
 */
async function logFieldDiffs(...args) {
  let conn = null
  let opts = null

  if (args.length === 2 && args[0] && typeof args[0].execute === 'function') {
    // вызов в стиле: (conn, opts)
    ;[conn, opts] = args
  } else {
    ;[opts] = args
  }

  if (!opts || typeof opts !== 'object') return

  const {
    req,
    // разные имена для совместимости
    oldData,
    newData,
    before,
    after,
    entity_type,
    entity_id,
    comment = null,
    excludeFields = DEFAULT_EXCLUDES,
  } = opts

  const prev = oldData ?? before
  const next = newData ?? after

  if (!prev || !next) return

  const idNum =
    entity_id === undefined || entity_id === null || entity_id === '' ? null : Number(entity_id)
  if (idNum === null || Number.isNaN(idNum)) {
    console.error('❌ logFieldDiffs: invalid entity_id:', entity_id)
    return
  }

  const client_id = prev?.client_id ?? null // для совместимости со старыми логами клиентов

  const keys = uniqueKeys(Object.keys(prev), Object.keys(next)).filter(
    (k) => !excludeFields.includes(k)
  )

  for (const key of keys) {
    const was = prev[key]
    const now = next[key]

    if (isEqualLoosely(was, now)) continue

    try {
      await logActivity({
        req,
        action: 'update',
        entity_type,
        entity_id: idNum,
        field_changed: key,
        old_value: stringifyMaybe(was),
        new_value: stringifyMaybe(now),
        comment,
        client_id, // для suppliers будет null — это ок
      })
    } catch (e) {
      // не роняем цепочку из-за одного сбоя
      console.error(`logFieldDiffs: failed to log field "${key}" for ${entity_type}:${idNum}`, e)
    }
  }
}

/* ---------- helpers ---------- */

const DEFAULT_EXCLUDES = [
  'id',
  'created_at',
  'updated_at',
  'version',
  'supplier_id',
  'client_id',
  'created_by',
  'updated_by',
]

function uniqueKeys(a, b) {
  const s = new Set([...a, ...b])
  return Array.from(s)
}

function isObjectLike(v) {
  return v !== null && typeof v === 'object'
}

function stringifyMaybe(v) {
  if (v === undefined) return ''
  if (v === null) return ''
  if (isObjectLike(v)) {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

/**
 * Сравнение "мягкое": null/undefined/"" считаем эквивалентными пустоте,
 * объекты сравниваем по JSON
 */
function isEqualLoosely(a, b) {
  const normEmpty = (x) => (x === undefined || x === null || x === '' ? '' : x)
  const aa = normEmpty(a)
  const bb = normEmpty(b)

  if (isObjectLike(aa) || isObjectLike(bb)) {
    return stringifyMaybe(aa) === stringifyMaybe(bb)
  }
  return String(aa) === String(bb)
}

module.exports = logFieldDiffs
