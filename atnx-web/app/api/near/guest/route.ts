import { isNearChain } from '@/lib/near/config';
import { clientIp } from '@/lib/near/guest';
import { NearNotConfigured, guestDeps } from '@/lib/near/server';
import { handleGuestCreate, type RouteResult } from '@/lib/near/routes';

// A guest account for this browser, with no sign-in (lib/near/routes.ts
// handleGuestCreate, lib/near/guest.ts). NEAR build only.
//   POST { publicKey: "ed25519:..." }
//     -> 201 { accountId: "guest-xxxxxxxx.atnx.testnet", publicKey, state,
//              guest: true, created: true, txHash }
//     -> 200 the same account again for a key already on record
//     -> 409 in_progress | key_used, 429 guest_limit_ip | guest_limit_day,
//        503 relayer_empty, 502 create_failed, 400 bad_public_key
// The account holds zero NEAR; its only key is that public key, as a
// function-call key for the rounds contract. No Supabase session is read or
// made: a guest is not an ATNX user. The caps count the salted hash of the
// client's IP (x-forwarded-for, else x-real-ip), never the IP itself.
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const MAX_BODY = 1_024;

function reply(r: RouteResult): Response {
  return Response.json(r.body, { status: r.status, headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!isNearChain()) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY) return Response.json({ error: 'bad_public_key' }, { status: 413, headers: NO_STORE });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  try {
    return reply(await handleGuestCreate(guestDeps(), { ip: clientIp(request.headers) }, body));
  } catch (err) {
    if (err instanceof NearNotConfigured) return Response.json({ error: 'not_configured' }, { status: 503, headers: NO_STORE });
    console.error('[near/guest]', (err as Error)?.message ?? err);
    // A Supabase error with a code (e.g. the table is missing before 005 is applied).
    const code = (err as { code?: string })?.code;
    return Response.json({ error: 'server_error', code: code ?? null }, { status: 500, headers: NO_STORE });
  }
}
