import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePostgres, getPostgresPool } from './postgres.mjs';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(currentDirectory, 'migrations');
const lockId = 761_053_533;

try {
  const pool = await getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    await client.query(`CREATE TABLE IF NOT EXISTS chat_schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await fs.readdir(migrationsDirectory))
      .filter((filename) => /^\d+.*\.sql$/i.test(filename))
      .sort((left, right) => left.localeCompare(right));
    const applied = new Set((await client.query('SELECT filename FROM chat_schema_migrations')).rows.map((row) => row.filename));
    for (const filename of files) {
      if (applied.has(filename)) {
        console.log(`[chat-migration] skipped ${filename}`);
        continue;
      }
      const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO chat_schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        console.log(`[chat-migration] applied ${filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    client.release();
  }
} finally {
  await closePostgres();
}
