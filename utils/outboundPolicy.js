const VALID_MODES = new Set(['live', 'disabled', 'fixture'])

const defaultOutboundMode = (env = process.env) => {
  const environment = String(env.APP_ENV || env.NODE_ENV || 'local').toLowerCase()
  return ['staging', 'recovery', 'restore', 'dr'].includes(environment) ? 'disabled' : 'live'
}

const getOutboundMode = (service, env = process.env) => {
  const serviceVariable = `${String(service).toUpperCase()}_OUTBOUND_MODE`
  const mode = String(env[serviceVariable] || env.OUTBOUND_MODE || defaultOutboundMode(env))
    .trim()
    .toLowerCase()
  if (!VALID_MODES.has(mode)) {
    throw new Error(`${serviceVariable} must be live, disabled, or fixture`)
  }
  return mode
}

const outboundDisabledError = (service) => {
  const error = new Error(`${service} outbound integration is disabled`)
  error.code = 'OUTBOUND_DISABLED'
  error.status = 503
  return error
}

module.exports = { VALID_MODES, defaultOutboundMode, getOutboundMode, outboundDisabledError }
