// The logic of the NEAR "Start rounds" server action
// (startNearSeriesAction in app/app/actions/rounds.ts), without Next or
// Supabase, as lib/near/routes.ts is for the API routes: it takes the
// session, the account store, the start and the revalidation as
// dependencies, so the tests run it against fakes and the in-memory store.
//
// The finder is always the signed-in user's own NEAR account, read from the
// session and bm.near_accounts (supabase/bm/004_near_accounts.sql), never an
// account the browser names: the finder earns a share of the series' fees.
// The account must be active; one still being set up cannot start rounds.
import type { StartResult } from '@/lib/bm/rounds-core';
import type { NearAccountStore } from './store';

type StartFailure = Extract<StartResult, { ok: false }>;

export type NearStartCode = 'signed_out' | 'no_account' | 'account_creating' | 'not_live' | 'server' | StartFailure['code'];

// The shape the NEAR ticket expects (StartNearSeries in
// components/rounds/NearRoundTicket.tsx). Nothing else goes back to the
// browser: no registry rows.
export type NearStartResult = { ok: true } | { ok: false; error: string; code: NearStartCode };

export interface NearStartDeps {
  // Whether this site trades rounds on NEAR (NEXT_PUBLIC_BM_CHAIN=near).
  // A server action can be called by a direct POST, so the Solana build
  // refuses it rather than starting NEAR series nobody there can see.
  enabled: boolean;
  // The signed-in user from the Supabase session cookie, or null.
  sessionUser: () => Promise<{ id: string } | null>;
  store: Pick<NearAccountStore, 'getByUser'>;
  // startNearSeries in lib/bm/rounds-near.ts.
  start: (input: { marketId: string; finder: string; fast?: boolean }) => Promise<StartResult>;
  // revalidatePath from next/cache.
  revalidate: (path: string) => void;
}

const UUID = /^[0-9a-f-]{36}$/i;

export const START_ERRORS = {
  signed_out: 'Sign in to start rounds.',
  no_account: 'Your trading account is not set up yet. Reload the page.',
  account_creating: 'Your trading account is still being set up. Try again in a moment.',
  not_live: 'Rounds are not live on NEAR testnet yet.',
  bad_account: 'Your trading account cannot start rounds. Reload the page.',
  tx: 'Rounds could not be started just now. Try again in a minute.',
  server: 'Rounds could not be started just now. Try again later.',
} as const;

// startNearSeries' messages for the market and its index are the Solana
// start's own (lib/bm/rounds-core.ts) and already plain words; they pass
// through. What the chain or the send said is for the logs, not the user.
function plainFailure(r: StartFailure): NearStartResult {
  switch (r.code) {
    case 'not_found':
    case 'scoring':
    case 'no_vi':
    case 'stale_vi':
    case 'already_active':
      return { ok: false, code: r.code, error: r.error };
    case 'chain':
      if (r.error === 'bad wallet') return { ok: false, code: 'chain', error: START_ERRORS.bad_account };
      if (/not live on NEAR/i.test(r.error)) return { ok: false, code: 'not_live', error: START_ERRORS.not_live };
      console.error('[rounds] NEAR start refused', r.error);
      return { ok: false, code: 'chain', error: START_ERRORS.tx };
    case 'tx':
    default:
      console.error('[rounds] NEAR start failed', r.error);
      return { ok: false, code: 'tx', error: START_ERRORS.tx };
  }
}

// "Start rounds" on a market page for the signed-in user: their active
// NEAR account becomes the series' finder; the keeper pays for the series.
// `fast` is the labelled hourly demo series, which startNearSeries allows
// from the site only where the ticket offers it.
export async function startNearSeriesForSession(deps: NearStartDeps, atnxMarketId: unknown, fast: unknown): Promise<NearStartResult> {
  if (typeof atnxMarketId !== 'string' || !UUID.test(atnxMarketId)) {
    return { ok: false, error: 'Bad request', code: 'not_found' };
  }
  if (!deps.enabled) return { ok: false, code: 'not_live', error: START_ERRORS.not_live };
  let result: StartResult;
  try {
    const user = await deps.sessionUser();
    if (!user) return { ok: false, code: 'signed_out', error: START_ERRORS.signed_out };
    const account = await deps.store.getByUser(user.id);
    if (!account) return { ok: false, code: 'no_account', error: START_ERRORS.no_account };
    if (account.state !== 'active') return { ok: false, code: 'account_creating', error: START_ERRORS.account_creating };
    result = await deps.start({ marketId: atnxMarketId, finder: account.accountId, fast: fast === true });
  } catch (err) {
    // The session, the account table (missing before 004 is applied) or
    // the registry.
    console.error('[rounds] NEAR start threw', (err as Error)?.message ?? err);
    return { ok: false, code: 'server', error: START_ERRORS.server };
  }
  if (!result.ok) return plainFailure(result);
  deps.revalidate(`/app/markets/${atnxMarketId}`);
  deps.revalidate('/app');
  return { ok: true };
}
