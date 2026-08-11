const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const UNKNOWN = 'UNKNOWN'

function commandResult(command, args, { cwd, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error) {
    if (allowFailure) return { ok: false, status: null, stdout: '', stderr: result.error.message }
    throw result.error
  }
  const output = {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  }
  if (!output.ok && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed: ${sanitizeError(output.stderr || output.stdout)}`)
  }
  return output
}

function git(repoRoot, args, options = {}) {
  return commandResult('git', args, { cwd: repoRoot, ...options })
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const equals = argument.indexOf('=')
    if (equals !== -1) {
      options[argument.slice(2, equals)] = argument.slice(equals + 1)
      continue
    }
    if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      options[argument.slice(2)] = argv[index + 1]
      index += 1
      continue
    }
    options[argument.slice(2)] = true
  }
  return options
}

function parseRepositoryName(remoteUrl) {
  const normalized = String(remoteUrl || '').trim().replace(/\.git$/, '')
  const match = normalized.match(/github\.com[/:]([^/]+\/[^/]+)$/i)
  return match ? match[1] : UNKNOWN
}

function resolveMainSha(repoRoot) {
  for (const ref of ['refs/heads/main', 'refs/remotes/origin/main']) {
    const result = git(repoRoot, ['rev-parse', '--verify', ref], { allowFailure: true })
    if (result.ok) return result.stdout
  }
  return UNKNOWN
}

function isAncestor(repoRoot, ancestor, descendant) {
  if ([ancestor, descendant].includes(UNKNOWN)) return null
  const result = git(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true })
  if (result.status === 0) return true
  if (result.status === 1) return false
  return null
}

function collectRepositoryState(repoRoot) {
  const absoluteRoot = fs.realpathSync(repoRoot)
  const branchResult = git(absoluteRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
  const branch = branchResult.ok ? branchResult.stdout : 'DETACHED'
  const headSha = git(absoluteRoot, ['rev-parse', 'HEAD']).stdout
  const mainSha = resolveMainSha(absoluteRoot)
  const remote = git(absoluteRoot, ['remote', 'get-url', 'origin'], { allowFailure: true })
  const dirtyEntries = git(absoluteRoot, ['status', '--porcelain=v1', '--untracked-files=normal']).stdout
    .split('\n')
    .filter(Boolean)
  return {
    repository: remote.ok ? parseRepositoryName(remote.stdout) : UNKNOWN,
    current_branch: branch,
    head_sha: headSha,
    main_sha: mainSha,
    merged_into_main: isAncestor(absoluteRoot, headSha, mainSha),
    working_tree_clean: dirtyEntries.length === 0,
    working_tree_change_count: dirtyEntries.length,
  }
}

function listWorktrees(repoRoot) {
  const lines = git(repoRoot, ['worktree', 'list', '--porcelain']).stdout.split('\n')
  const worktrees = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) }
      worktrees.push(current)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length)
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    }
  }
  return worktrees
}

function isGitRepository(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return false
  return git(candidate, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }).stdout === 'true'
}

function resolveContextDirectory(backendRoot, options = {}, env = process.env) {
  const explicit = options['output-dir'] || env.AI_CONTEXT_DIR
  if (explicit) return path.resolve(explicit)
  const contextWorktree = listWorktrees(backendRoot)
    .find((item) => item.branch === 'refs/heads/ai-context')
  if (contextWorktree) return contextWorktree.path
  throw new Error(
    'Unable to resolve ai-context worktree. Set AI_CONTEXT_DIR or add a worktree checked out at branch ai-context.'
  )
}

function resolveFrontendRepository(backendRoot, options = {}, env = process.env) {
  const explicit = options['frontend-repo'] || env.ERP_FRONTEND_REPO
  const candidates = []
  if (explicit) candidates.push(path.resolve(explicit))
  for (const worktree of listWorktrees(backendRoot)) {
    if (worktree.branch === 'refs/heads/main') {
      candidates.push(path.join(path.dirname(worktree.path), 'crusher-parts-frontend'))
    }
  }
  candidates.push(path.resolve(backendRoot, '..', 'crusher-parts-frontend'))
  const resolved = candidates.find(isGitRepository)
  if (!resolved) {
    throw new Error(
      'Unable to resolve frontend repository. Set ERP_FRONTEND_REPO or place crusher-parts-frontend beside the primary backend worktree.'
    )
  }
  return fs.realpathSync(resolved)
}

function resolveBackendRoot(fromDirectory = __dirname) {
  const result = git(fromDirectory, ['rev-parse', '--show-toplevel'])
  return fs.realpathSync(result.stdout)
}

function sanitizeError(error) {
  return String(error?.message || error || UNKNOWN)
    .replace(/(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500)
}

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid timestamp: ${value}`)
  return date.toISOString()
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o644 })
  fs.renameSync(temporaryPath, filePath)
}

function secretFindings(content) {
  const patterns = [
    { name: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
    { name: 'google-private-key', regex: /"private_key"\s*:\s*"(?!\[REDACTED\])/i },
    { name: 'credential-value', regex: /(?:DB_PASSWORD|JWT_SECRET|REFRESH_SECRET|OPENAI_API_KEY)\s*[=:]\s*["']?(?!UNKNOWN|\[REDACTED\]|NOT_SET)[^\s,"']+/i },
    { name: 'bearer-token', regex: /Bearer\s+[A-Za-z0-9._~+\/-]{20,}/i },
  ]
  return patterns.filter(({ regex }) => regex.test(content)).map(({ name }) => name)
}

module.exports = {
  UNKNOWN,
  collectRepositoryState,
  commandResult,
  git,
  isoTimestamp,
  listWorktrees,
  parseArguments,
  parseRepositoryName,
  resolveBackendRoot,
  resolveContextDirectory,
  resolveFrontendRepository,
  sanitizeError,
  secretFindings,
  writeFileAtomic,
}
