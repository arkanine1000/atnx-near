// Server wiring for the NEAR routes: the secrets from the environment, the
// relayer, the parent account that creates user and guest accounts, the
// salt of the guests' IP hashes, and the signed-in Supabase user. Imported by app/api/near/* and the server
// actions only; never by client code (it reads BM_NEAR_PARENT_SECRET and
// BM_NEAR_RELAYER_SECRET).
import { createHash } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { NEAR_PARENT, NEAR_ROUNDS, NEAR_RPC, USER_METHODS } from './config';
import { hashIp } from './guest';
import { createRelayer, roundsRelayPolicy, type Relayer } from './relay';
import { parentAccountChain } from './server-chain';
import { roundsAppCheck } from './rounds-check';
import { roundsViewer } from './rounds';
import type { AccountDeps, GuestDeps, RelayDeps, RouteUser } from './routes';
import { supabaseNearAccountStore, supabaseNearGuestStore } from './store-supabase';
import type { NearAccountStore, NearGuestStore } from './store';

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
let guestStore: NearGuestStore | null = null;
let parentChain: ReturnType<typeof parentAccountChain> | null = null;

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

// bm.near_guests (supabase/bm/005_near_guests.sql).
export function nearGuestStore(): NearGuestStore {
  if (!guestStore) guestStore = supabaseNearGuestStore();
  return guestStore;
}

function parentAccount(): ReturnType<typeof parentAccountChain> {
  if (!NEAR_ROUNDS || !NEAR_PARENT) throw new NearNotConfigured('NEXT_PUBLIC_BM_NEAR_ROUNDS / NEXT_PUBLIC_BM_NEAR_PARENT');
  if (!parentChain) parentChain = parentAccountChain({ rpcUrl: NEAR_RPC, parentId: NEAR_PARENT, parentKey: env('BM_NEAR_PARENT_SECRET'), roundsId: NEAR_ROUNDS });
  return parentChain;
}

export function accountDeps(): AccountDeps {
  return { store: nearAccountStore(), chain: parentAccount(), parentId: NEAR_PARENT };
}

// The parent's floor for making a guest: the relayer's own floor (0.05 NEAR,
// lib/near/relay.ts). Each account costs the parent about 0.007 NEAR.
const PARENT_FLOOR_YOCTO = 50_000_000_000_000_000_000_000n;

// The salt of the guests' IP hashes: BM_NEAR_GUEST_IP_SALT, or, when that is
// not set, a value derived one way from the parent's key, so it is secret and
// stable across instances without another variable to set. Either way it
// never leaves the server.
function guestIpSalt(): string {
  const explicit = process.env.BM_NEAR_GUEST_IP_SALT;
  if (explicit) return explicit;
  return createHash('sha256').update(`atnx-near-guest-ip-salt/v1:${env('BM_NEAR_PARENT_SECRET')}`, 'utf8').digest('hex');
}

export function guestDeps(): GuestDeps {
  const chain = parentAccount();
  const salt = guestIpSalt();
  return {
    store: nearGuestStore(),
    chain,
    parentId: NEAR_PARENT,
    hashIp: (ip) => hashIp(salt, ip),
    hasFunds: async () => (await nearRelayer().hasFloat()) && (await chain.spendable()) >= PARENT_FLOOR_YOCTO,
  };
}

export function relayDeps(): RelayDeps {
  const r = nearRelayer();
  return {
    store: nearAccountStore(),
    guests: { store: nearGuestStore(), parentId: NEAR_PARENT },
    relayer: r,
    appCheck: roundsAppCheck(roundsViewer({ provider: r.provider, contractId: NEAR_ROUNDS })),
  };
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
