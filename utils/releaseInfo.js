const pkg = require('../package.json')

const UNKNOWN = 'unknown'
const MAX_IDENTIFIER_LENGTH = 256
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:/@-]+$/

function safeIdentifier(value, fallback = UNKNOWN) {
  if (typeof value !== 'string') return fallback

  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > MAX_IDENTIFIER_LENGTH ||
    !SAFE_IDENTIFIER.test(normalized)
  ) {
    return fallback
  }

  return normalized
}

function buildReleaseInfo(env = process.env) {
  return Object.freeze({
    schemaVersion: 1,
    service: 'crusher-parts-backend',
    applicationVersion: pkg.version,
    commitSha: safeIdentifier(
      env.RELEASE_COMMIT_SHA || env.COMMIT_SHA || env.GIT_COMMIT
    ),
    buildId: safeIdentifier(env.RELEASE_BUILD_ID || env.BUILD_ID),
    artifact: safeIdentifier(env.RELEASE_ARTIFACT),
    revision: safeIdentifier(env.K_REVISION),
  })
}

module.exports = {
  UNKNOWN,
  buildReleaseInfo,
  safeIdentifier,
}
