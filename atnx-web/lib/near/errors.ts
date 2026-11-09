// What a refused or failed NEAR action means, in words for someone who has
// never traded: no keys, nonces, gas or relayers. The contract's error text
// comes back from the relay route either way (refused before sending, or
// failed on chain), so one table covers both.
import { NearActError } from './client';

const CONTRACT: Record<string, string> = {
  "round is not the series' presale round": 'This round is no longer taking commits. Reload to see the next one.',
  "round is not the series' live round": 'This round is no longer live. Reload to see where it stands.',
  'trading closed for the settlement window': "Trading has closed for this round's averaging window.",
  'series is paused': 'This series is paused.',
  'fewer shares than the minimum you set': 'The price moved while you were confirming. Try again.',
  'a single buy may not exceed 1000x the money on its side': 'That buy is too large for the money on this side.',
  'nothing to claim': 'Nothing to claim on this round.',
  'no position in this round': 'Nothing to claim on this round.',
  'round is not settled': 'This round is not settled yet.',
  'amount is zero': 'The amount is too small.',
  'balance too low': 'Not enough test USDG.',
  'mint above the per-call cap': 'That is more test USDG than one request can give.',
  'no such series': 'This series is not on chain yet. Reload in a minute.',
  'no such round': 'This round is not on chain yet. Reload in a minute.',
};

const CODES: Record<string, string> = {
  faucet_full: 'You already have plenty of test USDG.',
  rate_limited: 'That is a lot of actions for one hour. Try again later.',
  busy: 'Another action is still going through. Try again in a moment.',
  expired: 'That took too long to go through. Try again.',
  stale_nonce: 'Something else went through first. Try again.',
  signed_out: 'Sign in to trade.',
  no_account: 'Your account needs setting up again. Reload the page.',
  key_mismatch: 'This browser no longer holds your account. Reload the page.',
  unknown_key: 'This browser no longer holds your account. Reload the page.',
  relayer_empty: 'Trading is paused for a moment on our side. Try again later.',
  not_configured: 'Trading is not set up on this site yet.',
  // The guest branch of the relay.
  not_a_guest: 'This browser no longer holds your account. Reload the page.',
  guests_off: 'Guest accounts are unavailable right now. Sign in to trade.',
  method_not_allowed: 'A test account cannot do that. Sign in to use the full account.',
};

export function friendlyNearError(err: unknown): string {
  if (err instanceof NearActError) {
    if (err.contractMessage && CONTRACT[err.contractMessage]) return CONTRACT[err.contractMessage];
    if (CODES[err.code]) return CODES[err.code];
    if (err.code === 'failed_on_chain') return "It didn't go through. Nothing was taken; try again.";
    if (err.status >= 500) return 'Trading is unavailable right now. Try again later.';
    return "It didn't go through. Try again.";
  }
  const msg = String((err as Error)?.message ?? err).split('\n')[0];
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) return 'Could not reach ATNX. Check your connection and try again.';
  return msg.slice(0, 140);
}
