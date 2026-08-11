#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const { parseArguments, secretFindings } = require('./common')
const { generateContext } = require('./update')

function evaluatePreflight({ result, env = process.env, now = new Date() }) {
  const failures = []
  const warnings = []
  const checks = []
  const add = (name, passed, detail, { warning = false } = {}) => {
    checks.push({ name, status: passed ? 'PASS' : warning ? 'WARN' : 'FAIL', detail })
    if (!passed) (warning ? warnings : failures).push(`${name}: ${detail}`)
  }

  const { contextDirectory, systemState } = result
  const requiredFiles = [
    'AI_CONTEXT.md', 'SYSTEM_STATE.json', 'DATABASE_STATE.md', 'CHATGPT_REVIEW_INSTRUCTIONS.md',
  ]
  const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(contextDirectory, file)))
  add('required-context-files', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'all required files exist')

  let parsed = null
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(contextDirectory, 'SYSTEM_STATE.json'), 'utf8'))
  } catch (error) {
    add('system-state-json', false, error.message)
  }
  if (parsed) add('system-state-json', parsed.manifest_version === 2, `manifest_version=${parsed.manifest_version}`)

  const ageMs = now.valueOf() - new Date(systemState.generated_at).valueOf()
  add('context-freshness', ageMs >= -60_000 && ageMs <= 15 * 60_000, `age_ms=${ageMs}`)

  const backend = systemState.repositories.backend
  const frontend = systemState.repositories.frontend
  add('backend-head-match', parsed?.repositories?.backend?.head_sha === backend.head_sha, backend.head_sha)
  add('frontend-head-match', parsed?.repositories?.frontend?.head_sha === frontend.head_sha, frontend.head_sha)
  add('feature-branch-isolation', backend.current_branch !== 'main', `backend branch=${backend.current_branch}`)

  const requireClean = env.REVIEW_REQUIRE_CLEAN === '1'
  add(
    'backend-working-tree',
    backend.working_tree_clean,
    backend.working_tree_clean ? 'clean' : `${backend.working_tree_change_count} change(s)`,
    { warning: !requireClean }
  )
  add(
    'frontend-working-tree',
    frontend.working_tree_clean,
    frontend.working_tree_clean ? 'clean' : `${frontend.working_tree_change_count} change(s)`,
    { warning: !requireClean }
  )

  const database = systemState.database
  const requireDb = env.REVIEW_REQUIRE_DB === '1'
  add('database-availability', database.availability === 'AVAILABLE', database.reason || database.availability, { warning: !requireDb })
  if (database.availability === 'AVAILABLE') {
    add('database-schema-drift', database.schema_drift === false, `schema_drift=${database.schema_drift}`)
    add('database-pending-migrations', database.pending_migrations.length === 0, `pending=${database.pending_migrations.length}`)
    add('database-unresolved-failures', database.migration_ledger.unresolved_failed === 0, `unresolved_failed=${database.migration_ledger.unresolved_failed}`)
  }

  const deployment = systemState.deployment
  const requireGcp = env.REVIEW_REQUIRE_GCP === '1'
  add('deployment-availability', deployment.availability === 'AVAILABLE', deployment.reason || deployment.availability, { warning: !requireGcp })
  const featureDeployed = deployment.active_backend_feature_status === 'DEPLOYED_FEATURE'
  add(
    'unauthorized-feature-deployment',
    !featureDeployed || env.REVIEW_DEPLOYMENT_AUTHORIZED === '1',
    `feature_status=${deployment.active_backend_feature_status}`
  )

  for (const file of ['SYSTEM_STATE.json', 'DATABASE_STATE.md']) {
    const content = fs.readFileSync(path.join(contextDirectory, file), 'utf8')
    const findings = secretFindings(content)
    add(`secret-scan:${file}`, findings.length === 0, findings.length ? findings.join(', ') : 'no secret patterns')
  }

  const backendPackage = JSON.parse(fs.readFileSync(path.join(result.backendRoot, 'package.json'), 'utf8'))
  const frontendPackage = JSON.parse(fs.readFileSync(path.join(result.frontendRoot, 'package.json'), 'utf8'))
  add('backend-test-command', Boolean(backendPackage.scripts?.test), backendPackage.scripts?.test || 'missing')
  add('frontend-build-command', Boolean(frontendPackage.scripts?.build), frontendPackage.scripts?.build || 'missing')
  add('frontend-test-command', Boolean(frontendPackage.scripts?.test), frontendPackage.scripts?.test || 'not defined', { warning: true })

  return { verdict: failures.length ? 'FAIL' : 'PASS', checks, failures, warnings }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const updateArgs = []
  for (const [key, value] of Object.entries(options)) {
    if (value === true) updateArgs.push(`--${key}`)
    else updateArgs.push(`--${key}`, value)
  }
  const result = await generateContext({ argv: updateArgs })
  const evaluation = evaluatePreflight({ result })
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`)
  if (evaluation.verdict !== 'PASS') process.exitCode = 1
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { evaluatePreflight }
