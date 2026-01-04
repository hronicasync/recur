import pg from 'pg';

const allowSelfSigned = process.env.ALLOW_SELF_SIGNED === '1';

if (allowSelfSigned) {
  // Если соединение проходит через корпоративный прокси с self-signed сертификатом,
  // можно задать ALLOW_SELF_SIGNED=1, чтобы отключить строгую проверку.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  pg.defaults.ssl = { rejectUnauthorized: false };
}

const { Pool, types } = pg;

// Parse Postgres numeric as float
types.setTypeParser(1700, (value) => (value === null ? null : parseFloat(value)));

types.setTypeParser(20, (value) => (value === null ? null : parseInt(value, 10))); // int8

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is missing. Add it to your .env file.');
}

export const pool = new Pool({
  connectionString,
  ssl: allowSelfSigned
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true },
});

export const query = (text, params = []) => pool.query(text, params);

export const transact = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
};
