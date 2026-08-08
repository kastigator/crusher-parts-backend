const test = require('node:test')
const assert = require('node:assert/strict')

const { UNKNOWN, buildReleaseInfo, safeIdentifier } = require('../utils/releaseInfo')

test('release info exposes only the approved non-secret identifiers', () => {
  const info = buildReleaseInfo({
    RELEASE_COMMIT_SHA: '18a3a61a1e3c629d4214b7ab93618d757e8d075e',
    RELEASE_BUILD_ID: 'build-123',
    RELEASE_ARTIFACT: 'gcr.io/partsfinsad/crusher-backend:18a3a61',
    K_REVISION: 'crusher-backend-00312-gw9',
    DB_PASSWORD: 'must-not-appear',
    JWT_SECRET: 'must-not-appear',
  })

  assert.deepEqual(Object.keys(info), [
    'schemaVersion',
    'service',
    'applicationVersion',
    'commitSha',
    'buildId',
    'artifact',
    'revision',
  ])
  assert.equal(info.commitSha, '18a3a61a1e3c629d4214b7ab93618d757e8d075e')
  assert.equal(JSON.stringify(info).includes('must-not-appear'), false)
})

test('unsafe or missing release identifiers are replaced with unknown', () => {
  assert.equal(safeIdentifier('contains a space'), UNKNOWN)
  assert.equal(safeIdentifier('line\nbreak'), UNKNOWN)
  assert.equal(buildReleaseInfo({}).commitSha, UNKNOWN)
})
