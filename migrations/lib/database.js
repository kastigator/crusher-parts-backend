const path = require('node:path')

const dotenv = require('dotenv')
const mysql = require('mysql2/promise')

function loadDatabaseConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'local'
  dotenv.config({ path: path.resolve(process.cwd(), `.env.${nodeEnv}`) })

  const config = {
    user: process.env.DB_USER || 'kastigator',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'crusher_parts_db',
    multipleStatements: true,
  }

  if (process.env.DB_HOST?.startsWith('/cloudsql/')) {
    config.socketPath = process.env.DB_HOST
  } else {
    config.host = process.env.DB_HOST || '127.0.0.1'
    config.port = Number(process.env.DB_PORT || 3306)
  }

  return config
}

async function createMigrationConnection(env = process.env) {
  return mysql.createConnection(loadDatabaseConfig(env))
}

module.exports = {
  createMigrationConnection,
  loadDatabaseConfig,
}
