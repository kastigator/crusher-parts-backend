const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const proxyBinary = process.platform === 'win32' ? 'cloud-sql-proxy.exe' : 'cloud-sql-proxy'
const proxyPath = path.join(rootDir, proxyBinary)

if (!fs.existsSync(proxyPath)) {
  console.error(`Missing Cloud SQL Proxy binary at ${proxyPath}`)
  process.exit(1)
}

const proxyArgs = [
  '--port',
  '3306',
  'partsfinsad:europe-west4:parts',
  '--credentials-file=./google-credentials.json'
]

const proxy = spawn(proxyPath, proxyArgs, { cwd: rootDir, stdio: 'inherit' })

const nodemonBinary = process.platform === 'win32' ? 'nodemon.cmd' : 'nodemon'
const nodemonPath = path.join(rootDir, 'node_modules', '.bin', nodemonBinary)

let server
if (fs.existsSync(nodemonPath)) {
  if (process.platform === 'win32') {
    server = spawn('cmd.exe', ['/c', nodemonPath, 'server.js'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'local' }
    })
  } else {
    server = spawn(nodemonPath, ['server.js'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'local' }
    })
  }
} else {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  if (process.platform === 'win32') {
    server = spawn('cmd.exe', ['/c', npxCmd, 'nodemon', 'server.js'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'local' }
    })
  } else {
    server = spawn(npxCmd, ['nodemon', 'server.js'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'local' }
    })
  }
}

const shutdown = (signal) => {
  if (server && !server.killed) server.kill(signal)
  if (proxy && !proxy.killed) proxy.kill(signal)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', () => shutdown())

server.on('exit', (code) => {
  if (proxy && !proxy.killed) proxy.kill()
  process.exit(code ?? 0)
})

proxy.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`Cloud SQL Proxy exited with code ${code}`)
  }
})
