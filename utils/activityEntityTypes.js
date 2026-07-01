const ENTITY_TYPE_ALIASES = {
  client_request: 'client_requests',
  client_orders: 'client_requests',
  client_order_items: 'client_request_revision_items',
  client_order_contracts: 'client_contracts',
  rfq: 'rfqs',
  sales_quote: 'sales_quotes',
  client_contract: 'client_contracts',
  supplier_purchase_order: 'supplier_purchase_orders',
  part_suppliers: 'suppliers',
  user: 'users',
}

function canonicalizeEntityType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  return ENTITY_TYPE_ALIASES[normalized] || normalized
}

module.exports = {
  ENTITY_TYPE_ALIASES,
  canonicalizeEntityType,
}
