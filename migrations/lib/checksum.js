const crypto = require('node:crypto')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeSql(sql) {
  return String(sql).replace(/\r\n?/g, '\n')
}

function migrationChecksum(sql) {
  return sha256(normalizeSql(sql))
}

module.exports = {
  migrationChecksum,
  normalizeSql,
  sha256,
}
