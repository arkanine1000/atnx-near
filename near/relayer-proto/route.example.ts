// SKETCH, not wired into any repo. How relay.mjs drops into Next.js 16 route handlers
// (app/api/near/relay/route.ts and app/api/near/account/route.ts), behind Supabase auth.
// Assumes a table near_accounts(user_id uuid pk, account_id text unique, created_at).
//
// env: NEAR_RPC_URL, NEAR_RELAYER_ID, NEAR_RELAYER_KEY (ed25519:...), NEAR_PARENT_ID,
//      NEAR_PARENT_KEY, NEAR_ROUNDS_ID, NEAR_CUSTODY_PUBLIC_KEY (optional recovery key)

import { Account, KeyPair, KeyPairSigner, PublicKey, actions, nearToYocto } from 'near-api-js';
import { createRelayer, RelayRejected, RelayFailed } from '@/lib/near/relay'; // = relay.mjs
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

const ROUNDS = process.env.NEAR_ROUNDS_ID!; // rounds.atnx.testnet
const USER_METHODS = ['commit', 'buy', 'claim', 'claim_rollover', 'faucet', 'withdraw'];

const relayer = createRelayer({
  relayerId: process.env.NEAR_RELAYER_ID!,
  relayerKey: process.env.NEAR_RELAYER_KEY!,
  rpcUrl: process.env.NEAR_RPC_URL!,
  policy: {
    contractId: ROUNDS,
    methods: USER_METHODS,
    senderPattern: /^[a-z0-9_-]+\.atnx\.testnet$/,
    requireFunctionCallKey: true,
  },
});

async function nearAccountOf(userId: string) {
  const { data } = await createAdminClient()
    .from('near_accounts').select('account_id').eq('user_id', userId).maybeSingle();
  return data?.account_id as string | undefined;
}

// POST /api/near/relay  { signedDelegate: base64 }  ->  { txHash }
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

  const accountId = await nearAccountOf(user.id);
  if (!accountId) return Response.json({ error: 'no NEAR account yet' }, { status: 409 });

  const { signedDelegate } = await request.json().catch(() => ({}));
  if (typeof signedDelegate !== 'string') return Response.json({ error: 'expected signedDelegate' }, { status: 400 });

  // TODO before launch: per-user rate limit, and one in-flight relay per user (nonce ordering).
  try {
    const txHash = await relayer.relay(signedDelegate, { expectedSenderId: accountId });
    return Response.json({ txHash });
  } catch (e) {
    if (e instanceof RelayRejected) return Response.json({ error: e.reason }, { status: 400 });
    if (e instanceof RelayFailed) return Response.json({ error: 'failed on chain', txHash: e.txHash, failure: e.failure }, { status: 422 });
    throw e;
  }
}

// POST /api/near/account  { publicKey: "ed25519:..." }  ->  { accountId }
// (Goes in its own app/api/near/account/route.ts as `export async function POST`; a route file
// may only export HTTP method handlers and route config, so it can't sit beside the relay POST.)
// First sign-in: the browser made a key (WebCryptoSigner.generate) and sends the PUBLIC key.
// The server creates <handle>.atnx.testnet with that key as a function-call key for rounds,
// plus (optionally) ATNX's custody key as full access, which is what makes a new device recoverable.
export async function createAccountHandler(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });
  if (await nearAccountOf(user.id)) return Response.json({ error: 'already has an account' }, { status: 409 });

  const { publicKey } = await request.json();
  const pk = PublicKey.from(publicKey); // throws on garbage
  const handle = `u${user.id.replace(/-/g, '').slice(0, 12)}`; // or a sanitized username; must be [a-z0-9_-]
  const accountId = `${handle}.${process.env.NEAR_PARENT_ID}`;

  const parent = new Account(process.env.NEAR_PARENT_ID!, process.env.NEAR_RPC_URL!,
    new KeyPairSigner(KeyPair.fromString(process.env.NEAR_PARENT_KEY as `ed25519:${string}`)));
  await parent.signAndSendTransaction({
    receiverId: accountId,
    actions: [
      actions.createAccount(), // zero-balance account: < 770 bytes, no transfer needed
      actions.addFunctionCallAccessKey(pk, ROUNDS, USER_METHODS, nearToYocto('0.25')),
      ...(process.env.NEAR_CUSTODY_PUBLIC_KEY
        ? [actions.addFullAccessKey(PublicKey.from(process.env.NEAR_CUSTODY_PUBLIC_KEY))]
        : []),
    ],
    waitUntil: 'FINAL',
  });
  await createAdminClient().from('near_accounts').insert({ user_id: user.id, account_id: accountId });
  return Response.json({ accountId });
}
// New device: same handler shape, but the custody key signs AddKey(newBrowserKey, FC rounds) on the existing account.
