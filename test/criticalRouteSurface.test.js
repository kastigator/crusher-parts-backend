const test = require('node:test')
const assert = require('node:assert/strict')

function routeSignatures(router) {
  return new Set(
    (router.stack || [])
      .filter((layer) => layer.route)
      .flatMap((layer) =>
        Object.entries(layer.route.methods)
          .filter(([, enabled]) => enabled)
          .map(([method]) => `${method.toUpperCase()} ${layer.route.path}`)
      )
  )
}

const protectedSurfaces = {
  catalogPositions: ['GET /', 'GET /:id/card', 'GET /:id/usage'],
  equipmentModels: ['GET /:id', 'GET /:id/bom', 'GET /:id/client-executions'],
  clientRequests: ['GET /', 'GET /:id', 'GET /:id/workspace'],
  rfqs: ['GET /', 'GET /:id', 'GET /:id/items', 'GET /:id/structure'],
}

for (const [moduleName, expectedRoutes] of Object.entries(protectedSurfaces)) {
  test(`${moduleName} keeps the characterized protected read surface`, () => {
    const signatures = routeSignatures(require(`../routes/${moduleName}`))
    for (const signature of expectedRoutes) {
      assert.equal(signatures.has(signature), true, `${moduleName}: missing ${signature}`)
    }
  })
}
