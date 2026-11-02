import { describe, it, expect } from 'vitest';
import { getSeededDb } from '../helpers/db-helper';
import { evaluateDataQuality } from '../helpers/dq-evaluator';

describe('Data Quality: Pre-Code Gate G4 Composite Score', () => {
  it('TC-DQ-SCORE-001: Golden Dataset achieves 100.0% composite Data Quality Score', () => {
    const db = getSeededDb();
    const metrics = evaluateDataQuality(db);

    console.log('\n📊 Pre-Code Data Quality Gate (Gate G4) Score Card:');
    console.log(`  • Completeness (C):            ${metrics.completeness}%`);
    console.log(`  • Validity (V):                ${metrics.validity}%`);
    console.log(`  • Referential Integrity (R):   ${metrics.referentialIntegrity}%`);
    console.log(`  • Uniqueness (U):              ${metrics.uniqueness}%`);
    console.log(`  • Chronological Consistency (T):${metrics.chronology}%`);
    console.log(`  -------------------------------------------------`);
    console.log(`  🏆 Composite DQ Score:         ${metrics.compositeScore}%\n`);

    expect(metrics.completeness).toBe(100.0);
    expect(metrics.validity).toBe(100.0);
    expect(metrics.referentialIntegrity).toBe(100.0);
    expect(metrics.uniqueness).toBe(100.0);
    expect(metrics.chronology).toBe(100.0);
    expect(metrics.compositeScore).toBe(100.0);
  });
});
