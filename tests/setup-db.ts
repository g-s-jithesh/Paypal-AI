import os from 'os';
import path from 'path';

// Each vitest worker gets its own SQLite file (outside OneDrive-synced folders) so parallel
// test files can't clobber each other's seed state or contend on file locks.
process.env.DATABASE_PATH ??= path.join(os.tmpdir(), 'chargeback-shield-tests', `worker-${process.env.VITEST_POOL_ID ?? '0'}.db`);
