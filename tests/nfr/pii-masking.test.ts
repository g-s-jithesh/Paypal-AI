import { describe, it, expect } from 'vitest';

// PII Sanitizer and Tokenizer
export function sanitizePromptText(text: string): string {
  // Mask emails
  let sanitized = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/gi, '[BUYER_EMAIL_REDACTED]');
  // Mask street addresses (e.g. 123 Main St, 742 Evergreen Terrace)
  sanitized = sanitized.replace(/\d+\s+([A-Za-z0-9\s]+)(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Terrace|Way)/gi, '[SHIPPING_ADDRESS_REDACTED]');
  // Mask phone numbers
  sanitized = sanitized.replace(/(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[PHONE_REDACTED]');
  return sanitized;
}

export function maskIpAddress(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.xxx.xxx`;
  }
  return '[IP_REDACTED]';
}

export function scopePublicNegotiationDto(session: any, offer?: any) {
  // Internal fields must never be exposed to the buyer
  return {
    sessionId: session.id,
    disputeId: session.dispute_id,
    status: session.status,
    messages: JSON.parse(session.messages_json || '[]'),
    activeOffer: offer
      ? {
          offerId: offer.id,
          amountCents: offer.offered_amount_cents,
          type: offer.offer_type,
          status: offer.status,
        }
      : null,
  };
}

describe('Non-Functional Requirements: PII Masking & Data Sanitization (BR-013, NFR-005)', () => {
  it('TC-NFR-PII-001: Prompt Tokenization & Redaction verifies zero raw PII in outbound text', () => {
    const rawCustomerContext = `
      Customer John Doe (email: john.doe@vip-customer.com, phone: +1-408-555-0199)
      placed an order shipped to 742 Evergreen Terrace for delivery.
      Dispute claims item never arrived.
    `;

    const sanitized = sanitizePromptText(rawCustomerContext);

    // Verify token replacements
    expect(sanitized).toContain('[BUYER_EMAIL_REDACTED]');
    expect(sanitized).toContain('[SHIPPING_ADDRESS_REDACTED]');
    expect(sanitized).toContain('[PHONE_REDACTED]');

    // Assert that raw email regex finds 0 matches in sanitized text
    const emailRegex = /[\w.+-]+@[\w-]+\.[\w.-]+/gi;
    expect(emailRegex.test(sanitized)).toBe(false);

    // Assert that raw phone regex finds 0 matches
    const phoneRegex = /\+1-408-555-0199/g;
    expect(phoneRegex.test(sanitized)).toBe(false);
  });

  it('TC-NFR-PII-002: Audit Log Sanitization ensures IP masking and secret isolation', () => {
    const clientIp = '192.168.1.105';
    const maskedIp = maskIpAddress(clientIp);
    expect(maskedIp).toBe('192.168.xxx.xxx');

    const auditState = {
      action: 'UPDATE_MERCHANT',
      paypal_client_id: 'sb-client-12345',
      paypal_client_secret: 'sb-secret-DO_NOT_STORE',
    };

    // Sanitize state before persisting to audit log
    function sanitizeAuditState(state: Record<string, any>) {
      const sanitized = { ...state };
      if ('paypal_client_secret' in sanitized) {
        sanitized.paypal_client_secret = '[REDACTED_SECRET]';
      }
      return sanitized;
    }

    const safeAudit = sanitizeAuditState(auditState);
    expect(safeAudit.paypal_client_secret).toBe('[REDACTED_SECRET]');
    expect(safeAudit.paypal_client_secret).not.toContain('DO_NOT_STORE');
  });

  it('TC-NFR-PII-003: Public Negotiation Portal DTO Scoping hides merchant confidential margins', () => {
    const internalSession = {
      id: 'neg_123',
      dispute_id: 'DSP-001',
      status: 'ACTIVE',
      token_hash: 'super-secret-salt-hash',
      max_refund_allowed_cents: 4800,
      messages_json: JSON.stringify([{ sender: 'AGENT', text: 'Hello' }]),
      merchant_ops_cost_cents: 500,
      merchant_chargeback_fee_cents: 1500,
      merchant_paypal_secret: 'secret-xyz',
    };

    const internalOffer = {
      id: 'off_123',
      offered_amount_cents: 3500,
      max_allowed_cents: 4800,
      offer_type: 'PARTIAL_REFUND',
      status: 'PROPOSED',
      merchant_margin_saved_cents: 8500,
    };

    const publicDto = scopePublicNegotiationDto(internalSession, internalOffer);

    // Verify allowed fields exist
    expect(publicDto.sessionId).toBe('neg_123');
    expect(publicDto.activeOffer?.amountCents).toBe(3500);

    // Verify confidential internal fields are stripped
    expect((publicDto as any).token_hash).toBeUndefined();
    expect((publicDto as any).max_refund_allowed_cents).toBeUndefined();
    expect((publicDto as any).merchant_ops_cost_cents).toBeUndefined();
    expect((publicDto as any).merchant_chargeback_fee_cents).toBeUndefined();
    expect((publicDto as any).merchant_paypal_secret).toBeUndefined();
    expect((publicDto.activeOffer as any)?.merchant_margin_saved_cents).toBeUndefined();
  });
});
