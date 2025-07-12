const mysql = require('mysql2/promise');
require('dotenv').config();

const config = {
  user: process.env.DB_USER || 'kastigator',
  password: process.env.DB_PASSWORD || '192168',
  database: process.env.DB_NAME || 'crusher_parts_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

// Подключение через сокет, если указан DB_HOST как /cloudsql/...
if (process.env.DB_HOST && process.env.DB_HOST.startsWith('/cloudsql/')) {
  config.socketPath = process.env.DB_HOST;
} else {
  config.host = process.env.DB_HOST || '127.0.0.1';
  config.port = process.env.DB_PORT || 3306;
}

const pool = mysql.createPool(config);

module.exports = pool;
