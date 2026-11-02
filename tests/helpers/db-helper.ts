import DatabaseConstructor, { Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runGoldenSeeder } from '../../scripts/seed';
import { getDb, getDefaultDbPath } from '../../lib/db';

export function createTestDb(): Database {
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const schemaPath = path.resolve(process.cwd(), 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  return db;
}

export function getSeededDb(): Database {
  const dbPath = getDefaultDbPath();
  if (!fs.existsSync(dbPath)) {
    runGoldenSeeder();
  }
  return getDb();
}
