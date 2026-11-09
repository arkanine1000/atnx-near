// Server wiring for the NEAR routes: the secrets from the environment, the
// relayer, the parent account that creates user accounts, and the
// signed-in Supabase user. Imported by app/api/near/* and the server
// actions only; never by client code (it reads BM_NEAR_PARENT_SECRET and
// BM_NEAR_RELAYER_SECRET).
import { createClient } from '@/lib/supabase/server';
import { NEAR_PARENT, NEAR_ROUNDS, NEAR_RPC, USER_METHODS } from './config';
import { createRelayer, roundsRelayPolicy, type Relayer } from './relay';
import { parentAccountChain } from './server-chain';
import { roundsAppCheck } from './rounds-check';
import { roundsViewer } from './rounds';
import type { AccountDeps, RelayDeps, RouteUser } from './routes';
import { supabaseNearAccountStore } from './store-supabase';
import type { NearAccountStore } from './store';

export class NearNotConfigured extends Error {
  constructor(what: string) {
    super(`NEAR is not configured: ${what}`);
  }
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new NearNotConfigured(name);
  return v;
}

let relayer: Relayer | null = null;
let store: NearAccountStore | null = null;

export function nearRelayer(): Relayer {
  if (!relayer) {
    if (!NEAR_ROUNDS || !NEAR_PARENT) throw new NearNotConfigured('NEXT_PUBLIC_BM_NEAR_ROUNDS / NEXT_PUBLIC_BM_NEAR_PARENT');
    relayer = createRelayer({
      relayerId: env('BM_NEAR_RELAYER_ACCOUNT'),
      relayerKey: env('BM_NEAR_RELAYER_SECRET'),
      rpcUrl: NEAR_RPC,
      policy: roundsRelayPolicy(NEAR_ROUNDS, NEAR_PARENT, USER_METHODS),
    });
  }
  return relayer;
}

// bm.near_accounts, for the routes and the "Start rounds" server action
// (app/app/actions/rounds.ts).
export function nearAccountStore(): NearAccountStore {
  if (!store) store = supabaseNearAccountStore();
  return store;
}

export function accountDeps(): AccountDeps {
  if (!NEAR_ROUNDS || !NEAR_PARENT) throw new NearNotConfigured('NEXT_PUBLIC_BM_NEAR_ROUNDS / NEXT_PUBLIC_BM_NEAR_PARENT');
  return {
    store: nearAccountStore(),
    chain: parentAccountChain({ rpcUrl: NEAR_RPC, parentId: NEAR_PARENT, parentKey: env('BM_NEAR_PARENT_SECRET'), roundsId: NEAR_ROUNDS }),
    parentId: NEAR_PARENT,
  };
}

export function relayDeps(): RelayDeps {
  const r = nearRelayer();
  return { store: nearAccountStore(), relayer: r, appCheck: roundsAppCheck(roundsViewer({ provider: r.provider, contractId: NEAR_ROUNDS })) };
}

// The signed-in user from the Supabase cookie, with the names a handle can
// come from: the X username, then the ATNX profile handle. Never the email
// or the real name: the account id is public on chain.
export async function sessionUser(opts: { names?: boolean } = {}): Promise<RouteUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  if (!opts.names) return { id: user.id };
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const username = [meta.user_name, meta.preferred_username].find((v): v is string => typeof v === 'string' && v.length > 0) ?? null;
  const { data: profile } = await supabase.from('user_profiles').select('handle').eq('id', user.id).maybeSingle();
  return { id: user.id, username, handle: profile?.handle ?? null };
}
