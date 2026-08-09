#!/usr/bin/env node

// Intentionally does not load dotenv and does not reuse the application's DB_*
// variables. A masking target must be configured explicitly for each run.
const mysql = require('mysql2/promise')
const { assertMutationConfirmation, assertNonProductionTarget } = require('../utils/stagingSafety/targetGuard')
const { execute, inventory, verify } = require('../utils/stagingMasking/engine')
const { MysqlMaskingAdapter } = require('../utils/stagingMasking/mysqlAdapter')

const command = process.argv[2]
const VALID_COMMANDS = new Set(['inventory', 'dry-run', 'mask', 'verify'])

const required = (name) => {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const protectedTargets = () => {
  if (!process.env.PRODUCTION_TARGETS_JSON) {
    throw new Error('PRODUCTION_TARGETS_JSON is required for target comparison')
  }
  const parsed = JSON.parse(process.env.PRODUCTION_TARGETS_JSON)
  if (!Array.isArray(parsed)) throw new Error('PRODUCTION_TARGETS_JSON must be an array')
  return parsed
}

const forbiddenLiterals = () => {
  const raw = required('MASK_FORBIDDEN_LITERALS_JSON')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('MASK_FORBIDDEN_LITERALS_JSON must be an array of non-empty strings')
  }
  return parsed.map((value) => value.trim())
}

const safePlanSummary = (plan) => ({
  policyId: plan.policyId,
  tableCount: plan.tables.length,
  tables: plan.tables.map((table) => ({
    table: table.table,
    action: table.action,
    primaryKey: table.primaryKey,
    rules: [...new Set(table.columns.map(({ rule }) => rule))],
  })),
})

const main = async () => {
  if (!VALID_COMMANDS.has(command)) {
    throw new Error('Usage: staging-masking.js inventory|dry-run|mask|verify')
  }
  const target = assertNonProductionTarget({
    environment: required('MASK_TARGET_ENV'),
    projectId: process.env.MASK_TARGET_PROJECT_ID,
    instance: process.env.MASK_TARGET_INSTANCE,
    database: required('MASK_TARGET_DATABASE'),
    host: required('MASK_TARGET_HOST'),
  }, protectedTargets())
  const productionLiterals = forbiddenLiterals()
  if (command === 'mask') assertMutationConfirmation(process.env.MASK_TARGET_CONFIRMATION)

  const connection = await mysql.createConnection({
    host: target.host,
    port: Number(process.env.MASK_TARGET_PORT || 3306),
    user: required('MASK_TARGET_USER'),
    password: required('MASK_TARGET_PASSWORD'),
    database: target.database,
    ssl: process.env.MASK_TARGET_SSL === 'true' ? {} : undefined,
  })
  const adapter = new MysqlMaskingAdapter(connection, target.database)

  try {
    let result
    if (command === 'inventory') {
      const { plan } = await inventory(adapter)
      result = safePlanSummary(plan)
    } else if (command === 'verify') {
      result = await verify(adapter, { forbiddenLiterals: productionLiterals })
      if (result.status !== 'PASS') throw new Error('Masking verification failed')
    } else {
      const seed = required('MASKING_SEED')
      if (command === 'mask') await connection.beginTransaction()
      try {
        result = await execute(adapter, { mode: command, seed })
        if (command === 'mask') {
          const verification = await verify(adapter, { forbiddenLiterals: productionLiterals })
          result.verification = verification
          if (verification.status !== 'PASS') throw new Error('Post-mask verification failed')
          await connection.commit()
        }
      } catch (error) {
        if (command === 'mask') await connection.rollback()
        throw error
      }
    }
    process.stdout.write(`${JSON.stringify({ targetFingerprint: target.fingerprint, result }, null, 2)}\n`)
  } finally {
    await connection.end()
  }
}

main().catch((error) => {
  process.stderr.write(`staging masking failed: ${error.message}\n`)
  process.exitCode = 1
})
