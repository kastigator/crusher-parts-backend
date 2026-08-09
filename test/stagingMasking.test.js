const test = require('node:test')
const assert = require('node:assert/strict')

const { execute, inventory, verify } = require('../utils/stagingMasking/engine')

class MemoryAdapter {
  constructor(schema, data) {
    this.schema = schema
    this.data = structuredClone(data)
  }
  async discoverSchema() { return this.schema }
  async countRows(table) { return this.data[table].length }
  async readRows(table, columns) {
    return this.data[table].map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])))
  }
  async updateRow(table, primaryKey, before, after, changedColumns) {
    const row = this.data[table].find((candidate) => primaryKey.every((key) => candidate[key] === before[key]))
    changedColumns.forEach((column) => { row[column] = after[column] })
  }
  async purgeTable(table) { this.data[table] = [] }
  async foreignKeyViolations() {
    const clientIds = new Set(this.data.clients.map(({ id }) => id))
    return this.data.offers.filter(({ client_id }) => !clientIds.has(client_id)).map(({ id }) => ({ table: 'offers', id }))
  }
}

const column = (name, dataType = 'varchar', extra = {}) => ({
  name, dataType, columnType: dataType, isNullable: true, isPrimary: false, isForeign: false, ...extra,
})

const schema = {
  tables: [
    {
      name: 'clients', primaryKey: ['id'], columns: [
        column('id', 'int', { isPrimary: true, isNullable: false }),
        column('legal_name'), column('email'), column('phone'), column('bank_account'),
        column('address'), column('profile', 'json'),
      ],
    },
    {
      name: 'offers', primaryKey: ['id'], columns: [
        column('id', 'int', { isPrimary: true, isNullable: false }),
        column('client_id', 'int', { isForeign: true, isNullable: false }),
        column('total_amount', 'decimal'), column('quote_number'), column('document_url'),
      ],
    },
    {
      name: 'auth_sessions', primaryKey: ['id'], columns: [column('id', 'int', { isPrimary: true })],
    },
  ],
  foreignKeys: [],
}

const data = {
  clients: [{
    id: 7,
    legal_name: 'Real Customer LLC',
    email: 'person@real.example',
    phone: '+358401234567',
    bank_account: '12345678901234567890',
    address: 'Real street 10',
    profile: { contact: { email: 'nested@real.example', phone: '+358409998877' }, safe_code: 'ABC' },
  }],
  offers: [{ id: 9, client_id: 7, total_amount: 1000, quote_number: 'Q-2026-001', document_url: 'https://storage.googleapis.com/prod/document.pdf' }],
  auth_sessions: [{ id: 1 }],
}

test('inventory is schema-driven, versioned, and identifies rules without changing rows', async () => {
  const adapter = new MemoryAdapter(schema, data)
  const result = await inventory(adapter)
  assert.equal(result.plan.policyId, 'wave0-staging-mask-v1')
  assert.equal(result.plan.tables.find(({ table }) => table === 'auth_sessions').action, 'purge_auth_session')
  assert.deepEqual(adapter.data, data)
})

test('dry-run is deterministic and does not mutate data', async () => {
  const adapter = new MemoryAdapter(schema, data)
  const first = await execute(adapter, { mode: 'dry-run', seed: '0123456789abcdef' })
  const second = await execute(adapter, { mode: 'dry-run', seed: '0123456789abcdef' })
  assert.deepEqual(first, second)
  assert.deepEqual(adapter.data, data)
  assert.equal(first.checks.every(({ status }) => status === 'PASS'), true)
})

test('mask pseudonymizes PII recursively, removes documents, preserves keys and commercial relationships', async () => {
  const adapter = new MemoryAdapter(schema, data)
  const result = await execute(adapter, { mode: 'mask', seed: '0123456789abcdef' })
  const client = adapter.data.clients[0]
  const offer = adapter.data.offers[0]
  assert.equal(client.id, 7)
  assert.equal(offer.client_id, 7)
  assert.notEqual(offer.total_amount, 1000)
  assert.match(offer.quote_number, /^STAGE-COM-/)
  assert.equal(offer.document_url, null)
  assert.match(client.email, /@example\.invalid$/)
  assert.match(client.profile.contact.email, /@example\.invalid$/)
  assert.equal(client.profile.safe_code, 'ABC')
  assert.deepEqual(adapter.data.auth_sessions, [])
  assert.equal(result.tables.find(({ table }) => table === 'offers').beforeCount, 1)
  assert.equal((await verify(adapter)).status, 'PASS')
})

test('unknown sensitive-looking columns fail closed', async () => {
  const unsafeSchema = {
    tables: [{
      name: 'misc', primaryKey: ['id'], columns: [
        column('id', 'int', { isPrimary: true }),
        column('customerPrivateValue'),
      ],
    }],
  }
  await assert.rejects(inventory(new MemoryAdapter(unsafeSchema, { misc: [{ id: 1, customerPrivateValue: 'x' }] })), /no masking rule/)
})

test('verification detects configured production literals without returning values', async () => {
  const adapter = new MemoryAdapter(schema, data)
  adapter.data.clients[0].profile.safe_code = 'prod-bucket-reference'
  await execute(adapter, { mode: 'mask', seed: '0123456789abcdef' })
  const result = await verify(adapter, { forbiddenLiterals: ['prod-bucket'] })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.findings.some(({ rule }) => rule === 'configured_production_literal_1'), true)
  assert.equal(JSON.stringify(result).includes('prod-bucket-reference'), false)
})
