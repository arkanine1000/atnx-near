import { isNearChain } from '@/lib/near/config';
import { createTokenCache, handleIntentsQuote, quoteErrorText } from '@/lib/near/intents';

// POST { chain: "sol" | "base" | "arb" | "eth", amount: "25" }
//   -> 200 { quote: { sendUnits, receiveUnits, minReceiveUnits, feeUnits,
//            timeSecs, quotedAt, chain }, preview: true, recipient }
//   or { error, message } (400 input, 422 no quote, 502/503/504 1Click).
// A live NEAR Intents 1Click price for bringing that much USDC from that
// chain to NEAR, always as a dry run: it moves no money and needs no
// sign-in (lib/near/intents.ts, lib/near/README.md). NEAR build only.
export const maxDuration = 30;

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_BODY = 2_048;

// One tokens list per server instance, refreshed every five minutes.
const tokens = createTokenCache({ fetch: (url, init) => fetch(url, init) });

export async function POST(request: Request) {
  if (!isNearChain()) return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY) return Response.json({ error: 'bad_amount', message: quoteErrorText('bad_amount') }, { status: 413, headers: NO_STORE });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  try {
    const r = await handleIntentsQuote(
      {
        fetch: (url, init) => fetch(url, init),
        tokens,
        // Optional: a 1Click partner JWT lowers the fee. Without it the
        // quote carries 1Click's unauthenticated fee, and shows it.
        apiKey: process.env.NEAR_INTENTS_JWT || undefined,
        log: (msg, detail) => console.warn('[near/intents]', msg, detail),
      },
      body,
    );
    return Response.json(r.body, { status: r.status, headers: NO_STORE });
  } catch (err) {
    console.error('[near/intents]', err);
    return Response.json({ error: 'upstream', message: quoteErrorText('upstream') }, { status: 500, headers: NO_STORE });
  }
}
