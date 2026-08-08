const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const versionRouter = require('../routes/version')

test('GET /api/version returns safe release metadata without authentication', async (t) => {
  const previous = {
    RELEASE_COMMIT_SHA: process.env.RELEASE_COMMIT_SHA,
    RELEASE_BUILD_ID: process.env.RELEASE_BUILD_ID,
    RELEASE_ARTIFACT: process.env.RELEASE_ARTIFACT,
    K_REVISION: process.env.K_REVISION,
  }

  Object.assign(process.env, {
    RELEASE_COMMIT_SHA: 'commit-for-http-smoke',
    RELEASE_BUILD_ID: 'build-for-http-smoke',
    RELEASE_ARTIFACT: 'gcr.io/example/backend:commit-for-http-smoke',
    K_REVISION: 'revision-for-http-smoke',
  })

  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const app = express()
  app.use('/api/version', versionRouter)
  const server = app.listen(0)
  t.after(() => server.close())

  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  const response = await fetch(`http://127.0.0.1:${port}/api/version`)
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(payload.commitSha, 'commit-for-http-smoke')
  assert.equal(payload.buildId, 'build-for-http-smoke')
})
