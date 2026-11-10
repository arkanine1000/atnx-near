import { after } from 'next/server';
import { NEAR_HOUSE, isHouseProduct } from '@/lib/near/config';
import { onDemandPositionId } from '@/lib/near/house-check';
import type { CheckedDelegate, RelayResult } from '@/lib/near/relay';
import { NearNotConfigured, relayDeps, sessionUser } from '@/lib/near/server';
import { handleRelay } from '@/lib/near/routes';

// POST { signedDelegate: base64 } -> { txHash, value, events }
// The browser signed a NEP-366 delegate for one user call on the rounds
// contract (or, with NEXT_PUBLIC_BM_NEAR_PRODUCT=house, on the house
// contract from the user's house account); the relayer checks it against
// the policy its receiver names and the signed-in user's account, holds the
// user's relay lock, checks it against the chain and sends it, paying the
// gas (lib/near/routes.ts, lib/near/relay.ts).
// POST { signedDelegate, guest: true }: the same for a guest account
// (/api/near/guest), with no session: the sender must be an active guest,
// with a lower hourly cap and no withdraw.
// Errors: 400 { error: <reason> } before anything was sent, 409 busy or
// no_account, 403 not_a_guest, 429 rate_limited, 422 { error: 'failed_on_chain', txHash,
// message } after.
//
// After a house open or close has gone through, the keeper is asked for
// that market's quote at once (quoteOnDemand, lib/bm/house-keeper.ts), so
// the order fills in seconds. It runs after the answer has been sent
// (after(), next/server) and its failures are only logged: the keeper's
// every-minute run picks the order up either way.
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'private, no-store' };

// The house keeper's switch, as lib/bm/house-near.ts houseEnabled reads it.
const houseKeeperOn = () => process.env.BM_NEAR_HOUSE_ENABLED === '1';

function quoteAfterResponse(checked: CheckedDelegate, result: RelayResult): void {
  if (!isHouseProduct() || !NEAR_HOUSE || checked.da?.receiverId !== NEAR_HOUSE || !houseKeeperOn()) return;
  const id = onDemandPositionId(checked.methodName, checked.args, result.value);
  if (id === null) return;
  after(async () => {
    try {
      const { quoteOnDemand } = await import('@/lib/bm/house-keeper');
      const r = await quoteOnDemand(id);
      if (!r.ok) console.warn('[near/relay] quote on demand did not send', { positionId: r.positionId, reason: r.reason });
    } catch (err) {
      console.error('[near/relay] quote on demand failed', (err as Error)?.message ?? err);
    }
  });
}

export async function POST(request: Request) {
  try {
    const user = await sessionUser();
    const body = await request.json().catch(() => null);
    const r = await handleRelay({ ...relayDeps(), afterSend: quoteAfterResponse }, user, body);
    return Response.json(r.body, { status: r.status, headers: NO_STORE });
  } catch (err) {
    if (err instanceof NearNotConfigured) return Response.json({ error: 'not_configured' }, { status: 503, headers: NO_STORE });
    console.error('[near/relay]', err);
    const code = (err as { code?: string })?.code;
    return Response.json({ error: 'server_error', code: code ?? null }, { status: 500, headers: NO_STORE });
  }
}
