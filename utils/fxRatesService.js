// utils/fxRatesService.js
// Простая обёртка для получения FX-курсов с кешированием в памяти
// и (опционально) сохранением в БД, если таблица fx_rates существует.

const axios = require('axios')
const db = require('./db')

const TTL_MS = 6 * 60 * 60 * 1000 // 6 часов
const DEFAULT_DB_MAX_AGE_MS = (() => {
  const raw = Number(process.env.FX_DB_MAX_AGE_MIN)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw * 60 * 1000)
  return TTL_MS
})()
const cache = new Map() // key: "BASE->QUOTE" => { rate, fetchedAt, source }

const normCode = (v) => {
  if (!v) return null
  const s = String(v).trim().toUpperCase()
  return s.length === 3 ? s : null
}

async function loadFromDb(base, quote) {
  try {
    const [rows] = await db.execute(
      `SELECT rate, as_of
         FROM fx_rates
        WHERE base_currency = ? AND quote_currency = ?
        ORDER BY as_of DESC
        LIMIT 1`,
      [base, quote]
    )
    if (rows[0]) {
      return {
        rate: Number(rows[0].rate),
        fetchedAt: new Date(rows[0].as_of),
        source: 'db',
      }
    }
  } catch (err) {
    // Таблицы может не быть — молча игнорируем
    if (err.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('FX: db fetch skipped:', err.code || err.message)
    }
  }
  return null
}

async function saveToDb(base, quote, rate, as_of) {
  try {
    await db.execute(
      `INSERT INTO fx_rates (base_currency, quote_currency, rate, as_of)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE rate = VALUES(rate), as_of = VALUES(as_of)`,
      [base, quote, rate, as_of]
    )
  } catch (err) {
    // Таблицы может не быть — это ок
    if (err.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('FX: db save skipped:', err.code || err.message)
    }
  }
}

async function fetchFromApi(base, quote) {
  let endpoint =
    process.env.FX_API_URL ||
    `https://api.frankfurter.app/latest?from=${base}&to=${quote}`

  // Поддержка плейсхолдеров {base}/{quote} в кастомном URL
  endpoint = endpoint.replace('{base}', base).replace('{quote}', quote)

  const resp = await axios.get(endpoint, { timeout: 8000 })
  const data = resp?.data || {}

  const rate =
    data?.info?.rate ??
    data?.result ??
    data?.conversion_rate ??
    (data?.rates && data.rates[quote]) ??
    null

  if (!rate || !Number.isFinite(rate)) {
    throw new Error('FX API returned no rate')
  }
  return {
    rate: Number(rate),
    fetchedAt: new Date(),
    source: 'api',
  }
}

const isFresh = (entry, maxAgeMs, nowTs = Date.now()) => {
  if (!entry?.fetchedAt || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return true
  return nowTs - entry.fetchedAt.getTime() <= maxAgeMs
}

async function getRate(baseRaw, quoteRaw, { forceRefresh = false, maxDbAgeMs = DEFAULT_DB_MAX_AGE_MS } = {}) {
  const base = normCode(baseRaw)
  const quote = normCode(quoteRaw)
  if (!base || !quote) throw new Error('Некорректные коды валют')
  if (base === quote) return { rate: 1, fetchedAt: new Date(), source: 'same' }

  const key = `${base}->${quote}`
  const cached = cache.get(key)
  const nowTs = Date.now()
  if (
    cached &&
    !forceRefresh &&
    cached.fetchedAt &&
    nowTs - cached.fetchedAt.getTime() < TTL_MS
  ) {
    return cached
  }

  // 1) Попробуем БД (только если курс не просрочен)
  let fromDb = null
  if (!forceRefresh) {
    fromDb = await loadFromDb(base, quote)
    if (fromDb && isFresh(fromDb, maxDbAgeMs, nowTs)) {
      cache.set(key, fromDb)
      return fromDb
    }
  }

  // 2) API
  try {
    const fromApi = await fetchFromApi(base, quote)
    cache.set(key, fromApi)
    // сохраняем в БД, но не мешаем ответу при ошибке
    saveToDb(base, quote, fromApi.rate, fromApi.fetchedAt).catch(() => {})
    return fromApi
  } catch (err) {
    // Если API недоступен, возвращаем последний курс из БД как fallback
    if (fromDb) {
      const fallback = { ...fromDb, source: 'db_stale_fallback' }
      cache.set(key, fallback)
      return fallback
    }
    // Последний fallback — устаревший кэш в памяти
    if (cached) return { ...cached, source: 'cache_stale_fallback' }
    throw err
  }
}

async function convertAmount(amount, from, to, opts = {}) {
  const rateObj = await getRate(from, to, opts)
  const value =
    amount === undefined || amount === null
      ? null
      : Number(amount) * Number(rateObj.rate)
  return { ...rateObj, value }
}

module.exports = {
  getRate,
  convertAmount,
}
