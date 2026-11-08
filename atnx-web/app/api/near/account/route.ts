import { accountDeps, NearNotConfigured, sessionUser } from '@/lib/near/server';
import { handleAccountCreate, handleAccountGet, type RouteResult } from '@/lib/near/routes';

// The signed-in user's NEAR account (lib/near/routes.ts).
//   GET   -> { accountId, publicKey, state } or { accountId: null }
//   POST  { publicKey: "ed25519:...", fresh?: true } -> creates
//         <handle>.<parent> with zero NEAR and that key as its only key, a
//         function-call key for the rounds contract. The parent pays.
// The parent waits for finality, so a POST takes a few seconds.
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'private, no-store' };

function reply(r: RouteResult): Response {
  return Response.json(r.body, { status: r.status, headers: NO_STORE });
}

function failure(err: unknown): Response {
  if (err instanceof NearNotConfigured) return Response.json({ error: 'not_configured' }, { status: 503, headers: NO_STORE });
  console.error('[near/account]', err);
  // A Supabase error with a code (e.g. the table is missing before 004 is applied).
  const code = (err as { code?: string })?.code;
  return Response.json({ error: 'server_error', code: code ?? null }, { status: 500, headers: NO_STORE });
}

export async function GET() {
  try {
    const user = await sessionUser();
    return reply(await handleAccountGet(accountDeps(), user));
  } catch (err) {
    return failure(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await sessionUser({ names: true });
    const body = await request.json().catch(() => null);
    return reply(await handleAccountCreate(accountDeps(), user, body));
  } catch (err) {
    return failure(err);
  }
}
