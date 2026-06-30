let poolPromise;

const getConnectionConfig = () => {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  const sslEnabled = String(process.env.POSTGRES_SSL || process.env.PG_SSL || '').toLowerCase() === 'true';
  const ssl = sslEnabled ? { rejectUnauthorized: String(process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED || process.env.PG_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' } : undefined;
  if (connectionString) return { connectionString, ssl };
  const host = String(process.env.POSTGRES_HOST || '').trim();
  const database = String(process.env.POSTGRES_DATABASE || '').trim();
  const user = String(process.env.POSTGRES_USER || '').trim();
  if (!host || !database || !user) throw new Error('Configure DATABASE_URL or POSTGRES_HOST, POSTGRES_DATABASE and POSTGRES_USER for the PostgreSQL chat architecture.');
  return { host, port:Number(process.env.POSTGRES_PORT || 5432), database, user, password:process.env.POSTGRES_PASSWORD || undefined, ssl };
};

export const getPostgresPool = async () => {
  if (!poolPromise) {
    poolPromise = import('pg').then(({ default: pg }) => new pg.Pool({
      ...getConnectionConfig(),
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5_000),
    })).catch((error) => {
      poolPromise = undefined;
      throw new Error(`PostgreSQL chat layer unavailable: ${error.message}`, { cause: error });
    });
  }
  return poolPromise;
};

export const query = async (text, values = []) => (await getPostgresPool()).query(text, values);

export const withTransaction = async (callback) => {
  const client = await (await getPostgresPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const checkPostgres = async () => {
  const startedAt = Date.now();
  const result = await query('SELECT NOW() AS now');
  return { ok: true, latencyMs: Date.now() - startedAt, serverTime: result.rows[0]?.now };
};

export const closePostgres = async () => {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = undefined;
  await pool.end();
};
