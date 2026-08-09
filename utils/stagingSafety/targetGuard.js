const crypto = require('node:crypto')

const ALLOWED_NON_PRODUCTION_ENVIRONMENTS = new Set([
  'staging', 'recovery', 'test', 'development', 'local',
])

const normalize = (value) => String(value || '').trim().toLowerCase()

const targetFingerprint = (target) => crypto
  .createHash('sha256')
  .update(JSON.stringify({
    environment: normalize(target.environment),
    projectId: normalize(target.projectId),
    instance: normalize(target.instance),
    database: normalize(target.database),
    host: normalize(target.host),
  }))
  .digest('hex')
  .slice(0, 16)

const assertNonProductionTarget = (target, protectedTargets = []) => {
  const normalized = {
    environment: normalize(target?.environment),
    projectId: normalize(target?.projectId),
    instance: normalize(target?.instance),
    database: normalize(target?.database),
    host: normalize(target?.host),
  }

  if (!ALLOWED_NON_PRODUCTION_ENVIRONMENTS.has(normalized.environment)) {
    throw new Error('Target environment must be an explicit non-production environment')
  }
  if (!normalized.database || !normalized.host) {
    throw new Error('Target database and host are required')
  }
  if (/(^|[-_.])(prod|production)([-_.]|$)/i.test(
    [normalized.environment, normalized.projectId, normalized.instance, normalized.database, normalized.host].join(' ')
  )) {
    throw new Error('Target identity contains a production marker')
  }

  for (const protectedTarget of protectedTargets) {
    for (const field of ['projectId', 'instance', 'database', 'host']) {
      const protectedValue = normalize(protectedTarget?.[field])
      if (protectedValue && normalized[field] === protectedValue) {
        throw new Error(`Target ${field} matches a protected production target`)
      }
    }
  }

  return Object.freeze({ ...normalized, fingerprint: targetFingerprint(normalized) })
}

const assertMutationConfirmation = (confirmation) => {
  if (confirmation !== 'MASK_NON_PRODUCTION_DATA') {
    throw new Error('MASK_TARGET_CONFIRMATION must equal MASK_NON_PRODUCTION_DATA')
  }
}

module.exports = {
  ALLOWED_NON_PRODUCTION_ENVIRONMENTS,
  assertNonProductionTarget,
  assertMutationConfirmation,
  targetFingerprint,
}
