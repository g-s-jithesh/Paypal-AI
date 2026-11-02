/**
 * ChargebackShield — 1-Click Golden Dataset Reset Route
 * Restores 50 Golden disputes, orders, policy rules, and baseline state in < 500ms
 * Grounded in US-006 and Plan Step 45
 */

import { NextResponse } from 'next/server';
import { runGoldenSeeder } from '@/scripts/seed';
import { getDb } from '@/lib/db';

export async function POST() {
  const startTime = Date.now();
  try {
    runGoldenSeeder();
    const durationMs = Date.now() - startTime;

    const db = getDb();
    const countRow = db.prepare('SELECT count(*) as count FROM disputes').get() as { count: number };

    return NextResponse.json({
      success: true,
      message: 'Database successfully reset to Golden Dataset state',
      dispute_count: countRow?.count ?? 50,
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('Database Reset Error:', err);
    return NextResponse.json(
      { error: err.message || 'Database reset failed', duration_ms: Date.now() - startTime },
      { status: 500 }
    );
  }
}
