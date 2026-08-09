const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  CAPABILITY_DEFINITIONS,
  ROLE_CAPABILITY_PRESETS,
  buildPresetApplicationPlan,
} = require('../utils/capabilityModel')

const managedDir = path.resolve(__dirname, '..', 'migrations', 'managed')
const BASELINE_CAPABILITY_KEYS = [
  'catalogs.lookup',
  'catalogs.edit',
  'workflow.rfq.master_data.write',
  'workflow.client.master_data.write',
  'workflow.sales_quotes.manage',
  'workflow.contracts.manage',
  'workflow.purchase_orders.manage',
  'admin.users_roles.manage',
]

function managedCapabilityKeys() {
  const keys = []
  for (const file of fs.readdirSync(managedDir).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(managedDir, file), 'utf8')
    for (const block of sql.matchAll(/INSERT\s+INTO\s+capabilities\s*\([^;]+?\)\s*VALUES\s*([\s\S]+?)(?:ON\s+DUPLICATE|;)/gi)) {
      for (const row of block[1].matchAll(/\(\s*'([a-z0-9_.-]+)'\s*,/g)) keys.push(row[1])
    }
  }
  return [...new Set(keys)].sort()
}

test('canonical capability definitions exactly cover baseline plus all managed capability migrations through Wave 12', () => {
  const definitions = CAPABILITY_DEFINITIONS.map((item) => item.key).sort()
  assert.deepEqual(definitions, [...new Set([...BASELINE_CAPABILITY_KEYS, ...managedCapabilityKeys()])].sort())
  for (const key of [
    'completion.access',
    'completion.readiness.evaluate',
    'completion.close',
    'completion.reopen',
    'completion.history.view',
  ]) assert.ok(definitions.includes(key))
})

test('every preset is duplicate-free and references only canonical managed capabilities', () => {
  const definitions = CAPABILITY_DEFINITIONS.map((item) => item.key)
  for (const [roleSlug, presetKeys] of Object.entries(ROLE_CAPABILITY_PRESETS)) {
    const plan = buildPresetApplicationPlan({
      activeCapabilityKeys: definitions,
      presetKeys,
      definitionKeys: definitions,
    })
    assert.equal(plan.ok, true, roleSlug)
  }
})

test('preset application fails closed before replacement when active DB capabilities are newer than code', () => {
  const definitions = CAPABILITY_DEFINITIONS.map((item) => item.key)
  const plan = buildPresetApplicationPlan({
    activeCapabilityKeys: [...definitions, 'future_domain.valid_grant'],
    presetKeys: ROLE_CAPABILITY_PRESETS.prodavec,
    definitionKeys: definitions,
  })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.activeMissingFromCode, ['future_domain.valid_grant'])
})
