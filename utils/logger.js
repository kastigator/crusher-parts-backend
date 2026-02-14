const isProduction = process.env.NODE_ENV === 'production'
const debugEnabled = process.env.DEBUG_LOGS === '1' || !isProduction

const debug = (...args) => {
  if (debugEnabled) console.debug(...args)
}

const info = (...args) => {
  console.info(...args)
}

const warn = (...args) => {
  console.warn(...args)
}

const error = (...args) => {
  console.error(...args)
}

module.exports = {
  debug,
  info,
  warn,
  error,
}
