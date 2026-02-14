const mysql = require('mysql2/promise');
const path = require('path');
const dotenv = require('dotenv');
const logger = require('./logger');

const NODE_ENV = process.env.NODE_ENV || 'local';
dotenv.config({ path: path.resolve(process.cwd(), `.env.${NODE_ENV}`) });

const config = {
  user: process.env.DB_USER || 'kastigator',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'crusher_parts_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

if (process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/')) {
  config.socketPath = process.env.DB_HOST;
} else {
  config.host = process.env.DB_HOST || '127.0.0.1';
  config.port = process.env.DB_PORT || 3306;
}

// Только для локальной отладки:
if (NODE_ENV !== 'production') {
  logger.debug('📡 DB config from db.js:', {
    host: config.host || config.socketPath,
    user: config.user,
    database: config.database,
  });
}

const pool = mysql.createPool(config);
module.exports = pool;
