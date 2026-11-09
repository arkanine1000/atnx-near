// One live dry quote from NEAR Intents' 1Click API, through the same code as
// /api/near/intents/quote (lib/near/intents.ts), without the app:
//
//   npm run near:intents:quote                25 USDC from Solana
//   npm run near:intents:quote -- eth 100     100 USDC from Ethereum (sol, base, arb, eth)
//
// Prints the request it sent (always dry: true), 1Click's raw answer and
// the lines the Settings panel shows. A dry quote has no deposit address and
// moves no money. Needs no keys; NEAR_INTENTS_JWT, if set, is sent as the
// optional partner key.
import assert from 'node:assert/strict';
import { createTokenCache, fmtDuration, fmtFee, fmtUsdc, handleIntentsQuote, originByChain, type FetchLike, type QuotePreview } from '../lib/near/intents';

async function main() {
  const [chain = 'sol', amount = '25'] = process.argv.slice(2);
  const origin = originByChain(chain);
  if (!origin) {
    throw new Error(`Unknown chain "${chain}". Use sol, base, arb or eth.`);
  }

  const seen: { url: string; sent?: unknown; status: number; body: unknown }[] = [];
  const recording: FetchLike = async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the text
    }
    seen.push({ url, sent: init.body ? JSON.parse(init.body) : undefined, status: res.status, body });
    return { status: res.status, text: async () => text };
  };

  const t0 = Date.now();
  const r = await handleIntentsQuote({ fetch: recording, tokens: createTokenCache({ fetch: recording }), apiKey: process.env.NEAR_INTENTS_JWT || undefined }, { chain, amount });
  const ms = Date.now() - t0;

  const tokens = seen.find((s) => s.url.endsWith('/v0/tokens'));
  const quote = seen.find((s) => s.url.endsWith('/v0/quote'));
  console.log(`GET /v0/tokens -> ${tokens?.status}, ${Array.isArray(tokens?.body) ? tokens.body.length : '?'} tokens`);
  if (quote) {
    assert.equal((quote.sent as { dry?: unknown }).dry, true, 'the request was not dry');
    console.log('\nPOST /v0/quote, sent:');
    console.log(JSON.stringify(quote.sent, null, 2));
    console.log(`\n-> HTTP ${quote.status}:`);
    console.log(JSON.stringify(quote.body, null, 2));
  }
  console.log(`\nRoute result (${ms} ms): HTTP ${r.status}`);
  console.log(JSON.stringify(r.body, null, 2));

  if (r.status === 200) {
    const q = r.body.quote as QuotePreview;
    console.log('\nAs the panel shows it:');
    console.log(`  You send         ${fmtUsdc(q.sendUnits)} USDC on ${origin.label}`);
    console.log(`  Arrives on NEAR  ${fmtUsdc(q.receiveUnits)} USDC`);
    console.log(`  Fee              ${fmtFee(q.feeUnits)}`);
    console.log(`  Time             ${fmtDuration(q.timeSecs)}, once ${origin.label} confirms the transfer`);
    console.log('  Preview only: ATNX runs on NEAR testnet, so no money moves.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
