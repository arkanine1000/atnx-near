// Server wiring for the NEAR routes: the secrets from the environment, the
// relayer, the parent account that creates user and guest accounts, the
// salt of the guests' IP hashes, and the signed-in Supabase user. Imported by app/api/near/* and the server
// actions only; never by client code (it reads BM_NEAR_PARENT_SECRET and
// BM_NEAR_RELAYER_SECRET).
import { createHash } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { HOUSE_USER_METHODS, NEAR_HOUSE, NEAR_PARENT, NEAR_ROUNDS, USER_METHODS, isHouseProduct } from './config';
import { hashIp } from './guest';
import { houseViewer } from './house';
import { houseAppCheck } from './house-check';
import { createRelayer, houseRelayPolicy, roundsRelayPolicy, type RelayPolicy, type Relayer } from './relay';
import { serverRpcUrls } from './rpc-urls';
import { parentAccountChain } from './server-chain';
import { roundsAppCheck } from './rounds-check';
import { roundsViewer } from './rounds';
import { appCheckByReceiver, type AccountDeps, type GuestDeps, type HouseAccountDeps, type RelayDeps, type RouteUser } from './routes';
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

// The house is on (NEXT_PUBLIC_BM_NEAR_PRODUCT=house) and its contract is
// named. Off, everything below is the rounds alone, as before.
function houseOn(): boolean {
  return isHouseProduct() && !!NEAR_HOUSE && !!NEAR_PARENT;
}

export function nearRelayer(): Relayer {
  if (!relayer) {
    const house = houseOn();
    if ((!NEAR_ROUNDS && !house) || !NEAR_PARENT) throw new NearNotConfigured('NEXT_PUBLIC_BM_NEAR_ROUNDS / NEXT_PUBLIC_BM_NEAR_PARENT');
    // One policy per contract, chosen by the delegate's receiver: the
    // rounds (kept as they are, the fallback) and, with the house on, the
    // house.
    const policies: RelayPolicy[] = [];
    if (NEAR_ROUNDS) policies.push(roundsRelayPolicy(NEAR_ROUNDS, NEAR_PARENT, USER_METHODS));
    if (house) policies.push(houseRelayPolicy(NEAR_HOUSE, NEAR_PARENT, HOUSE_USER_METHODS));
    relayer = createRelayer({
      relayerId: env('BM_NEAR_RELAYER_ACCOUNT'),
      relayerKey: env('BM_NEAR_RELAYER_SECRET'),
      rpcUrl: serverRpcUrls(),
      policy: policies.length === 1 ? policies[0] : policies,
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
  if (!parentChain) {
    parentChain = parentAccountChain({
      rpcUrl: serverRpcUrls(),
      parentId: NEAR_PARENT,
      parentKey: env('BM_NEAR_PARENT_SECRET'),
      roundsId: NEAR_ROUNDS,
      houseId: houseOn() ? NEAR_HOUSE : undefined,
    });
  }
  return parentChain;
}

// With the house on, every account and guest also gets its house account.
function houseAccounts(chain: ReturnType<typeof parentAccountChain>): HouseAccountDeps | undefined {
  return houseOn() ? { contractId: NEAR_HOUSE, chain } : undefined;
}

export function accountDeps(): AccountDeps {
  const chain = parentAccount();
  return { store: nearAccountStore(), chain, parentId: NEAR_PARENT, house: houseAccounts(chain) };
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
    house: houseAccounts(chain),
    hashIp: (ip) => hashIp(salt, ip),
    hasFunds: async () => (await nearRelayer().hasFloat()) && (await chain.spendable()) >= PARENT_FLOOR_YOCTO,
  };
}

export function relayDeps(): RelayDeps {
  const r = nearRelayer();
  const roundsCheck = roundsAppCheck(roundsViewer({ provider: r.provider, contractId: NEAR_ROUNDS }));
  if (!houseOn()) {
    return {
      store: nearAccountStore(),
      guests: { store: nearGuestStore(), parentId: NEAR_PARENT },
      relayer: r,
      appCheck: roundsCheck,
    };
  }
  const checks: Record<string, (c: Parameters<typeof roundsCheck>[0]) => Promise<void>> = {
    [NEAR_HOUSE]: houseAppCheck(houseViewer({ provider: r.provider, contractId: NEAR_HOUSE })),
  };
  if (NEAR_ROUNDS) checks[NEAR_ROUNDS] = roundsCheck;
  return {
    store: nearAccountStore(),
    guests: { store: nearGuestStore(), parentId: NEAR_PARENT },
    relayer: r,
    appCheck: appCheckByReceiver(checks),
    house: { contractId: NEAR_HOUSE, parentId: NEAR_PARENT },
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
