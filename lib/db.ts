import DatabaseConstructor, { Database } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let dbInstance: Database | null = null;

export interface DbConfig {
  dbPath?: string;
  readonly?: boolean;
  verbose?: boolean;
}

/**
 * Returns the default database path.
 */
export function getDefaultDbPath(): string {
  if (process.env.DATABASE_PATH) {
    return path.resolve(process.cwd(), process.env.DATABASE_PATH);
  }
  return path.resolve(process.cwd(), 'chargeback_shield.db');
}

/**
 * Retrieves the singleton Database instance, configuring WAL mode and enforcing foreign keys.
 */
export function getDb(config?: DbConfig): Database {
  if (dbInstance && !config?.dbPath) {
    return dbInstance;
  }

  const targetPath = config?.dbPath ?? getDefaultDbPath();
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseConstructor(targetPath, {
    readonly: config?.readonly ?? false,
    verbose: config?.verbose ? console.log : undefined,
    timeout: 5000,
  });

  // Mandatory Pragmas (Grounded in PRD §6.1 & PROJECT.md)
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  if (!config?.dbPath) {
    dbInstance = db;
  }

  return db;
}

/**
 * Executes schema initialization from db/schema.sql.
 */
export function initializeDatabase(db?: Database): void {
  const conn = db ?? getDb();
  const schemaPath = path.resolve(process.cwd(), 'db', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${schemaPath}`);
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  conn.exec(schemaSql);
}

/**
 * Helper to run a synchronous block inside an atomic transaction.
 */
export function runTransaction<T>(fn: (db: Database) => T, db?: Database): T {
  const conn = db ?? getDb();
  const tx = conn.transaction(() => fn(conn));
  return tx();
}

/**
 * Closes the singleton database connection (essential for test runners and seeders).
 */
export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore if already closed
    }
    dbInstance = null;
  }
}
