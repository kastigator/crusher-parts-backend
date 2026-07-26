const assert = require('assert')

const routes = [
  'routerIndex',
  'clientRequests',
  'rfqs',
  'supplierResponses',
  'coverage',
  'economics',
  'selection',
  'salesQuotes',
  'contracts',
  'purchaseOrders',
  'warehouse',
  'scorecard',
  'catalogPositions',
  'supplierParts',
  'supplierPartCatalogPositions',
  'supplierPartPrices',
  'partSuppliers',
]

for (const route of routes) {
  const mod = require(`../routes/${route}`)
  assert(mod, `${route} module not found`)
  const type = typeof mod
  assert(type === 'function', `${route} router should be a function, got ${type}`)
}

console.log('smoke ok')
