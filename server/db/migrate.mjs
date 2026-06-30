import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePostgres, getPostgresPool } from './postgres.mjs';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(currentDirectory, 'migrations', '001_chat_architecture.sql');

try {
  const sql = await fs.readFile(migrationPath, 'utf8');
  const pool = await getPostgresPool();
  await pool.query(sql);
  console.log(`[chat-migration] applied ${path.basename(migrationPath)}`);
} finally {
  await closePostgres();
}
