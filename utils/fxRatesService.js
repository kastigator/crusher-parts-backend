// utils/fxRatesService.js
// Простая обёртка для получения FX-курсов с кешированием в памяти
// и (опционально) сохранением в БД, если таблица fx_rates существует.

const axios = require('axios')
const db = require('./db')
const { getOutboundMode, outboundDisabledError } = require('./outboundPolicy')

const TTL_MS = 6 * 60 * 60 * 1000 // 6 часов
const DEFAULT_DB_MAX_AGE_MS = (() => {
  const raw = Number(process.env.FX_DB_MAX_AGE_MIN)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw * 60 * 1000)
  return TTL_MS
})()
const cache = new Map() // key: "BASE->QUOTE" => { rate, fetchedAt, source }

const DEFAULT_FIXTURE_RATES = Object.freeze({
  'USD->RUB': 90,
  'EUR->RUB': 100,
  'CNY->RUB': 12.5,
  'EUR->USD': 1.1,
  'USD->CNY': 7.2,
})

const fixtureRates = (env = process.env) => {
  if (!env.FX_FIXTURE_RATES_JSON) return DEFAULT_FIXTURE_RATES
  const parsed = JSON.parse(env.FX_FIXTURE_RATES_JSON)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FX_FIXTURE_RATES_JSON must be a JSON object')
  }
  return parsed
}

const getFixtureRate = (base, quote, env = process.env) => {
  const rates = fixtureRates(env)
  const direct = parseRate(rates[`${base}->${quote}`])
  const reverse = parseRate(rates[`${quote}->${base}`])
  const rate = direct || (reverse ? 1 / reverse : null)
  if (!rate) throw new Error(`FX fixture has no rate for ${base}->${quote}`)
  return { rate, fetchedAt: new Date(0), source: 'fixture' }
}

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

const parseRate = (value) => {
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

async function fetchFromConfiguredApi(base, quote) {
  let endpoint =
    process.env.FX_API_URL ||
    `https://open.er-api.com/v6/latest/${base}`

  // Поддержка плейсхолдеров {base}/{quote} в кастомном URL
  endpoint = endpoint.replace('{base}', base).replace('{quote}', quote)

  const resp = await axios.get(endpoint, { timeout: 8000 })
  const data = resp?.data || {}
  const rate =
    parseRate(data?.rates?.[quote]) ??
    parseRate(data?.info?.rate) ??
    parseRate(data?.result) ??
    parseRate(data?.conversion_rate)

  if (!rate) {
    throw new Error('FX configured API returned no rate')
  }

  return {
    rate,
    fetchedAt: new Date(data?.time_last_update_utc || data?.time_last_update_unix * 1000 || Date.now()),
    source: process.env.FX_API_URL ? 'api_custom' : 'api_open_er',
  }
}

async function fetchFromFrankfurter(base, quote) {
  const endpoint = `https://api.frankfurter.app/latest?from=${base}&to=${quote}`
  const resp = await axios.get(endpoint, { timeout: 8000 })
  const data = resp?.data || {}
  const rate = parseRate(data?.rates?.[quote])

  if (!rate) {
    throw new Error('Frankfurter returned no rate')
  }

  return {
    rate,
    fetchedAt: data?.date ? new Date(`${data.date}T16:00:00Z`) : new Date(),
    source: 'api_frankfurter',
  }
}

async function fetchFromApi(base, quote) {
  const errors = []
  const providers = process.env.FX_API_URL
    ? [fetchFromConfiguredApi]
    : [fetchFromConfiguredApi, fetchFromFrankfurter]

  for (const provider of providers) {
    try {
      return await provider(base, quote)
    } catch (err) {
      errors.push(err?.message || String(err))
    }
  }

  throw new Error(errors.join(' | ') || 'FX providers failed')
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

  const mode = getOutboundMode('FX')
  if (mode === 'disabled') throw outboundDisabledError('FX')
  if (mode === 'fixture') return getFixtureRate(base, quote)

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
  getFixtureRate,
}
