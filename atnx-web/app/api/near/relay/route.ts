import { NearNotConfigured, relayDeps, sessionUser } from '@/lib/near/server';
import { handleRelay } from '@/lib/near/routes';

// POST { signedDelegate: base64 } -> { txHash, value, events }
// The browser signed a NEP-366 delegate for one user call on the rounds
// contract; the relayer checks it against the policy and the signed-in
// user's account, holds the user's relay lock, checks it against the chain
// and sends it, paying the gas (lib/near/routes.ts, lib/near/relay.ts).
// Errors: 400 { error: <reason> } before anything was sent, 409 busy or
// no_account, 429 rate_limited, 422 { error: 'failed_on_chain', txHash,
// message } after.
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    const user = await sessionUser();
    const body = await request.json().catch(() => null);
    const r = await handleRelay(relayDeps(), user, body);
    return Response.json(r.body, { status: r.status, headers: NO_STORE });
  } catch (err) {
    if (err instanceof NearNotConfigured) return Response.json({ error: 'not_configured' }, { status: 503, headers: NO_STORE });
    console.error('[near/relay]', err);
    const code = (err as { code?: string })?.code;
    return Response.json({ error: 'server_error', code: code ?? null }, { status: 500, headers: NO_STORE });
  }
}
