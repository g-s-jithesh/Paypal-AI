/**
 * ChargebackShield — Dual-Mode PayPal Factory & Barrel Export
 * Grounded in BR-024 (Zero-Error Fallback) and PROJECT.md § Interface Contracts
 */

import { PayPalDisputeClient } from './types';
import { MockPayPalSimulator } from './simulator';
import { LivePayPalClient } from './client';

export * from './types';
export * from './simulator';
export * from './client';

let simulatorInstance: MockPayPalSimulator | null = null;
let liveClientInstance: LivePayPalClient | null = null;

/**
 * Detects active PayPal mode based on environment variables and credentials (BR-024).
 */
export function getPayPalMode(): 'sandbox_simulated' | 'sandbox_live' {
  const mode = (process.env.PAYPAL_MODE || '').toLowerCase();
  const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
  const secret = (process.env.PAYPAL_CLIENT_SECRET || '').trim();

  const isLiveFlag = mode === 'sandbox_live' || mode === 'sandbox' || mode === 'live';
  const hasCreds = Boolean(
    clientId &&
    secret &&
    !clientId.startsWith('mock_') &&
    !clientId.startsWith('sb-client-mock')
  );

  return isLiveFlag && hasCreds ? 'sandbox_live' : 'sandbox_simulated';
}

/**
 * Returns singleton PayPal client instance with dynamic dual-mode switching.
 */
export function getPayPalClient(): PayPalDisputeClient {
  const mode = getPayPalMode();
  if (mode === 'sandbox_live') {
    if (!liveClientInstance) {
      liveClientInstance = new LivePayPalClient();
    }
    return liveClientInstance;
  }

  if (!simulatorInstance) {
    simulatorInstance = new MockPayPalSimulator();
  }
  return simulatorInstance;
}

/**
 * Resets cached singleton instances (useful for test isolation).
 */
export function resetPayPalClient(): void {
  simulatorInstance = null;
  liveClientInstance = null;
}

/**
 * Provides UI badge info for Judge Demo Bar and Top Navigation.
 */
export function getPayPalBadgeInfo() {
  const isLive = getPayPalMode() === 'sandbox_live';
  return {
    mode: isLive ? ('sandbox_live' as const) : ('sandbox_simulated' as const),
    label: isLive ? '🔷 PayPal: Live Sandbox [Connected]' : '🟢 PayPal: Local Simulator [Deterministic]',
    color: isLive ? ('blue' as const) : ('emerald' as const),
    isLive,
  };
}
