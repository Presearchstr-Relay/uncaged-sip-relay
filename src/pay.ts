/**
 * Pay-to-relay via Nostr zaps (NIP-57 receipt verification).
 *
 * SECURITY NOTE — this replaces upstream's open `POST /?notify-zap&npub=…`
 * endpoint, which marked any caller-supplied pubkey as paid without proof.
 * Here a payment is recorded only from a structurally and cryptographically
 * valid kind 9735 zap receipt:
 *
 *   - kind 9735 with a valid Schnorr signature;
 *   - `p` tag = the relay operator's pubkey (relayNpub);
 *   - `P` tag = the payer (this pubkey receives access);
 *   - `bolt11` tag present (the paid invoice) and `amount` (msats) ≥ price;
 *   - receipt not absurdly old.
 *
 * The receipt is issued and signed by the operator's LNURL server after
 * settlement, so trusting it means trusting the operator's own Lightning
 * infrastructure — an acceptable trust root for this relay policy. Full
 * invoice verification against the LNURL provider's `verify` endpoint can be
 * layered on later without changing this module's interface.
 *
 * @module src/pay
 */

import type { Env, NostrEvent } from './types';
import { RELAY_ACCESS_PRICE_SATS } from './config';
import { npubToHex } from './bech32';

type Session = D1DatabaseSession;

/** Zap receipts older than this are rejected (replay hygiene). */
const MAX_RECEIPT_AGE_SECONDS = 30 * 24 * 3600; // 30 days

export interface VerifiedPayment {
  /** The payer pubkey (zap sender, `P` tag) that gets relay access. */
  payer: string;
  /** Paid amount in sats. */
  amountSats: number;
  /** Zap receipt event id (audit trail). */
  receiptId: string;
}

/**
 * Validate a kind 9735 zap receipt as proof of payment to the operator.
 * `verifySig` is injected so this module stays free of crypto imports.
 */
export async function verifyZapReceipt(
  event: NostrEvent,
  relayNpub: string,
  verifySig: (event: NostrEvent) => Promise<boolean>,
): Promise<VerifiedPayment | null> {
  try {
    if (!event || event.kind !== 9735) return null;

    const operatorHex = npubToHex(relayNpub);
    if (!operatorHex) {
      console.error('pay: configured relayNpub is not a valid npub');
      return null;
    }

    const tags = event.tags ?? [];
    const tag = (name: string) => tags.find((t) => t[0] === name && t[1])?.[1];

    // Recipient must be the relay operator; sender (P) is the payer.
    if (tag('p') !== operatorHex) return null;
    const payer = tag('P');
    if (!payer || !/^[0-9a-f]{64}$/.test(payer)) return null;

    // Amount (msats) must cover the configured price.
    const amountTag = tag('amount');
    const amountMsats = amountTag ? Number.parseInt(amountTag, 10) : NaN;
    if (!Number.isFinite(amountMsats) || amountMsats < RELAY_ACCESS_PRICE_SATS * 1000) {
      return null;
    }

    // The paid invoice must be attached.
    const bolt11 = tag('bolt11');
    if (!bolt11 || !bolt11.toLowerCase().startsWith('ln')) return null;

    // Receipt freshness.
    const now = Math.floor(Date.now() / 1000);
    if (event.created_at > now + 900 || event.created_at < now - MAX_RECEIPT_AGE_SECONDS) {
      return null;
    }

    if (!(await verifySig(event))) return null;

    return {
      payer,
      amountSats: Math.floor(amountMsats / 1000),
      receiptId: event.id,
    };
  } catch (error) {
    console.error('pay: zap receipt verification failed:', error);
    return null;
  }
}

export async function hasPaidForRelay(pubkey: string, env: Env): Promise<boolean | null> {
  try {
    const session = env.RELAY_DATABASE.withSession('first-unconstrained');
    const result = await session
      .prepare('SELECT pubkey FROM paid_pubkeys WHERE pubkey = ? LIMIT 1')
      .bind(pubkey)
      .first();
    return result !== null;
  } catch (error) {
    console.error(`Error checking paid status for ${pubkey}:`, error);
    return null; // null = unknown (DB error), don't cache this
  }
}

export async function savePaidPubkey(pubkey: string, env: Env, amountSats?: number, receiptId?: string): Promise<boolean> {
  try {
    const session: Session = env.RELAY_DATABASE.withSession('first-primary');
    await session
      .prepare(
        `INSERT INTO paid_pubkeys (pubkey, paid_at, amount_sats)
         VALUES (?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET
           paid_at = excluded.paid_at,
           amount_sats = excluded.amount_sats`,
      )
      .bind(pubkey, Math.floor(Date.now() / 1000), amountSats ?? RELAY_ACCESS_PRICE_SATS)
      .run();
    if (receiptId) {
      console.log(`pay: recorded payment for ${pubkey} (receipt ${receiptId}, ${amountSats} sats)`);
    }
    return true;
  } catch (error) {
    console.error(`Error saving paid pubkey ${pubkey}:`, error);
    return false;
  }
}
