/**
 * Extract verified wallet address from x402 payment headers.
 *
 * Checks multiple sources in priority order:
 * 1. x-payer-address — injected by @x402/next's withX402 after verification (highest confidence)
 * 2. PAYMENT-SIGNATURE / X-PAYMENT — decode the payment header directly
 *
 * If the handler is executing, withX402 has already verified the payment signature.
 * For manual x402 flows, the app verifies before calling business logic.
 * Either way, the header content is trustworthy when this runs.
 */
export function extractVerifiedWallet(headers: Headers): string | null {
  try {
    // 1. x-payer-address: injected by @x402/next's withX402 after verification
    const payerAddress = headers.get('x-payer-address');
    if (payerAddress) {
      return payerAddress.toLowerCase();
    }

    // 2. Decode from PAYMENT-SIGNATURE or X-PAYMENT header
    const paymentHeader =
      headers.get('PAYMENT-SIGNATURE') ??
      headers.get('payment-signature') ??
      headers.get('X-PAYMENT') ??
      headers.get('x-payment');

    if (!paymentHeader) return null;

    // Try using @x402/core's decoder if available
    try {
      const { decodePaymentSignatureHeader } = require('@x402/core/http') as {
        decodePaymentSignatureHeader: (header: string) => {
          payload?: { authorization?: { from?: string }; from?: string };
        };
      };
      const payment = decodePaymentSignatureHeader(paymentHeader);
      const from = payment?.payload?.authorization?.from ?? payment?.payload?.from;
      return typeof from === 'string' ? from.toLowerCase() : null;
    } catch {
      // @x402/core not available or decode failed — try manual base64 decode
      try {
        const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString()) as {
          payload?: { authorization?: { from?: string }; from?: string };
        };
        const from = decoded?.payload?.authorization?.from ?? decoded?.payload?.from;
        return typeof from === 'string' ? from.toLowerCase() : null;
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}
