const LOCAL_ORIGINS = Object.freeze([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

const parseBoolean = (value, defaultValue) => {
  if (value === undefined || value === '') return defaultValue
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  throw new Error('CORS_ALLOW_NO_ORIGIN must be true or false')
}

const parseOrigins = (value) => String(value || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const validateOrigin = (origin) => {
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`Invalid CORS origin: ${origin}`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error(`CORS origin must be an exact http(s) origin: ${origin}`)
  }
  return origin
}

const buildCorsPolicy = (env = process.env) => {
  const nodeEnv = env.NODE_ENV || 'local'
  const configured = [
    ...parseOrigins(env.CORS_ORIGINS),
    ...parseOrigins(env.CORS_ORIGIN), // backward-compatible variable name
  ]
  const defaults = nodeEnv === 'local' || nodeEnv === 'development' ? LOCAL_ORIGINS : []
  const allowedOrigins = new Set([...defaults, ...configured].map(validateOrigin))
  const allowNoOrigin = parseBoolean(env.CORS_ALLOW_NO_ORIGIN, true)

  return Object.freeze({ allowedOrigins, allowNoOrigin })
}

const corsOptionsFromPolicy = (policy) => ({
  origin(origin, callback) {
    if (!origin && policy.allowNoOrigin) return callback(null, true)
    if (origin && policy.allowedOrigins.has(origin)) return callback(null, true)
    return callback(new Error(`Not allowed by CORS: ${origin || '<no-origin>'}`))
  },
  credentials: true,
})

module.exports = { LOCAL_ORIGINS, buildCorsPolicy, corsOptionsFromPolicy }
