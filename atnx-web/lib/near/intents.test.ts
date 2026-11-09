import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDry,
  buildDryQuoteRequest,
  BadQuoteResponse,
  classifyQuoteFailure,
  createTokenCache,
  DEADLINE_MS,
  findRoute,
  fmtDuration,
  fmtFee,
  fmtUsdc,
  handleIntentsQuote,
  IntentsTimeout,
  NEAR_USDC_ASSET,
  NotDryError,
  ORIGINS,
  originByChain,
  parseQuoteInput,
  parseQuoteResponse,
  parseTokens,
  parseUsdcAmount,
  postQuote,
  PREVIEW_RECIPIENT,
  toUsdcUnits,
  type DryQuoteRequest,
  type FetchInit,
  type FetchLike,
  type IntentsToken,
} from './intents';

const NOW = Date.parse('2026-11-09T21:00:00.000Z');
const SOL = originByChain('sol')!;

// GET /v0/tokens on 2026-11-09, the USDC entries the panel uses plus a
// look-alike (sUSDC on Base) it must not pick.
const TOKENS_JSON = [
  { assetId: NEAR_USDC_ASSET, decimals: 6, blockchain: 'near', symbol: 'USDC', price: 0.999447, priceUpdatedAt: '2026-11-09T21:00:31.039Z', contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDC', price: 0.999447, priceUpdatedAt: '2026-11-09T21:00:31.039Z', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', decimals: 6, blockchain: 'arb', symbol: 'USDC', price: 0.999447, priceUpdatedAt: '2026-11-09T21:00:31.039Z', contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 0.999447, priceUpdatedAt: '2026-11-09T21:00:31.039Z', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', price: 0.999447, priceUpdatedAt: '2026-11-09T21:00:31.039Z', contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', coingeckoId: 'usd-coin' },
  { assetId: 'nep141:base-0x1c4a802fd6b591bb71daa01d8335e43719048b24.omft.near', decimals: 6, blockchain: 'base', symbol: 'sUSDC', price: 0.999447, priceUpdatedAt: '2026-11-09T21:00:31.039Z', contractAddress: '0x1c4a802fd6b591bb71daa01d8335e43719048b24', coingeckoId: 'usd-coin' },
];
const TOKENS = parseTokens(TOKENS_JSON);

// POST /v0/quote, dry, 25 USDC Solana -> NEAR, as 1Click answered it on
// 2026-11-09 (HTTP 201; signature shortened).
const QUOTE_201 = {
  quote: {
    amountIn: '25000000',
    amountInFormatted: '25.0',
    amountInUsd: '24.986425000000',
    minAmountIn: '25000000',
    amountOut: '24995618',
    amountOutFormatted: '24.995618',
    amountOutUsd: '24.982045379426',
    minAmountOut: '24745661',
    timeEstimate: 20,
    refundFee: '0',
    withdrawFee: '0',
  },
  quoteRequest: {
    dry: true,
    depositMode: 'SIMPLE',
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: NEAR_USDC_ASSET,
    amount: '25000000',
    refundTo: PREVIEW_RECIPIENT,
    refundType: 'INTENTS',
    recipient: PREVIEW_RECIPIENT,
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-11-09T21:33:24.161Z',
    confidentiality: 'public',
    quoteWaitingTimeMs: 0,
    insured: false,
    appFees: [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 1 }],
  },
  signature: 'ed25519:2kGT5Ld2…',
  timestamp: '2026-11-09T21:03:24.255Z',
  correlationId: 'a830f484-85bf-4ba5-ad5c-1626173c97f8',
};
// The same day's refusals.
const TOO_LOW_400 = { message: 'Amount is too low for bridge, try at least 0', correlationId: '46acd05a', timestamp: '2026-11-09T21:03:51.265Z', path: '/v0/quote' };
const BAD_TOKEN_400 = { message: 'tokenIn is not valid', correlationId: '04319cfe', timestamp: '2026-11-09T21:03:51.404Z', path: '/v0/quote' };
const NO_RECIPIENT_400 = { message: 'Internal server error', correlationId: '954ecdc5', timestamp: '2026-11-09T21:03:31.670Z', path: '/v0/quote' };

interface Call {
  url: string;
  init: FetchInit;
}

// A fetch that records every call and answers from `reply`.
function fakeFetch(reply: (url: string, init: FetchInit) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = await reply(url, init);
    return { status: r.status, text: async () => JSON.stringify(r.json) };
  };
  return { fetch, calls };
}

// The quote endpoint answering `quote`, the tokens endpoint the list above.
function oneClick(quote: { status: number; json: unknown } = { status: 201, json: QUOTE_201 }) {
  return fakeFetch((url) => (url.endsWith('/v0/tokens') ? { status: 200, json: TOKENS_JSON } : quote));
}

function deps(fetch: FetchLike, over: Partial<Parameters<typeof handleIntentsQuote>[0]> = {}) {
  return { fetch, tokens: createTokenCache({ fetch, now: () => NOW }), now: () => NOW, ...over };
}

const quoteBodies = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/v0/quote')).map((c) => JSON.parse(c.init.body!) as Record<string, unknown>);

// ---------------------------------------------------------------- request

test('every request the builder makes is dry, for every chain and amount', () => {
  for (const origin of ORIGINS) {
    for (const units of [1_000_000n, 25_000_000n, 100_000_000_000n]) {
      const r = buildDryQuoteRequest({ origin, units }, NOW);
      assert.equal(r.dry, true);
      assert.equal(r.originAsset, origin.assetId);
      assert.equal(r.destinationAsset, NEAR_USDC_ASSET);
      assert.equal(r.amount, units.toString());
      assert.equal(r.swapType, 'EXACT_INPUT');
      assert.equal(r.depositType, 'ORIGIN_CHAIN');
      assert.equal(r.recipientType, 'DESTINATION_CHAIN');
      assert.equal(r.recipient, PREVIEW_RECIPIENT);
      assert.equal(r.refundTo, PREVIEW_RECIPIENT);
      assert.equal(r.refundType, 'INTENTS');
      assert.equal(r.deadline, new Date(NOW + DEADLINE_MS).toISOString());
    }
  }
});

test('the stand-in recipient is the all-zero implicit account', () => {
  assert.match(PREVIEW_RECIPIENT, /^0{64}$/);
});

test('assertDry passes only the boolean true', () => {
  assert.doesNotThrow(() => assertDry({ dry: true }));
  for (const bad of [{ dry: false }, { dry: 'true' }, { dry: 1 }, {}, null, undefined, 'dry']) {
    assert.throws(() => assertDry(bad), NotDryError);
  }
});

test('postQuote sends one dry POST to /v0/quote', async () => {
  const { fetch, calls } = oneClick();
  const r = await postQuote({ fetch }, buildDryQuoteRequest({ origin: SOL, units: 25_000_000n }, NOW));
  assert.equal(r.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://1click.chaindefuser.com/v0/quote');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body!).dry, true);
  assert.equal(calls[0].init.headers?.['X-API-Key'], undefined);
});

test('postQuote sends the optional key as X-API-Key', async () => {
  const { fetch, calls } = oneClick();
  await postQuote({ fetch, apiKey: 'jwt' }, buildDryQuoteRequest({ origin: SOL, units: 25_000_000n }, NOW));
  assert.equal(calls[0].init.headers?.['X-API-Key'], 'jwt');
});

test('postQuote refuses a body that is not dry and sends nothing', async () => {
  const { fetch, calls } = oneClick();
  const forged = { ...buildDryQuoteRequest({ origin: SOL, units: 25_000_000n }, NOW), dry: false } as unknown as DryQuoteRequest;
  await assert.rejects(postQuote({ fetch }, forged), NotDryError);
  // A getter that reads true once, then false in the JSON, is caught too.
  let reads = 0;
  const sneaky = { ...buildDryQuoteRequest({ origin: SOL, units: 25_000_000n }, NOW) } as Record<string, unknown>;
  Object.defineProperty(sneaky, 'dry', { enumerable: true, get: () => reads++ === 0 });
  await assert.rejects(postQuote({ fetch }, sneaky as unknown as DryQuoteRequest), NotDryError);
  assert.equal(calls.length, 0);
});

test('the route handler only ever sends dry: true', async () => {
  const { fetch, calls } = oneClick();
  for (const chain of ['sol', 'base', 'arb', 'eth']) {
    for (const amount of ['1', '25', '99999.5']) {
      await handleIntentsQuote(deps(fetch), { chain, amount, dry: false });
    }
  }
  const bodies = quoteBodies(calls);
  assert.equal(bodies.length, 12);
  for (const b of bodies) assert.equal(b.dry, true);
});

// ----------------------------------------------------------------- inputs

test('parseUsdcAmount reads USDC amounts between 1 and 100,000', () => {
  assert.deepEqual(parseUsdcAmount('25'), { ok: true, units: 25_000_000n });
  assert.deepEqual(parseUsdcAmount(' 25.5 '), { ok: true, units: 25_500_000n });
  assert.deepEqual(parseUsdcAmount('1'), { ok: true, units: 1_000_000n });
  assert.deepEqual(parseUsdcAmount('1.000001'), { ok: true, units: 1_000_001n });
  assert.deepEqual(parseUsdcAmount('100000'), { ok: true, units: 100_000_000_000n });
  assert.deepEqual(parseUsdcAmount('25.'), { ok: true, units: 25_000_000n });
  assert.deepEqual(parseUsdcAmount(25), { ok: true, units: 25_000_000n });
  for (const small of ['0', '0.5', '.5', '0.999999']) assert.deepEqual(parseUsdcAmount(small), { ok: false, error: 'too_small' }, small);
  for (const big of ['100000.000001', '1000000']) assert.deepEqual(parseUsdcAmount(big), { ok: false, error: 'too_large' }, big);
  for (const bad of ['', ' ', 'abc', '-5', '1e3', '1,000', '25.1234567', '0x10', '25 USDC', '1'.repeat(30), NaN, Infinity, null, undefined, {}, [25]]) {
    assert.deepEqual(parseUsdcAmount(bad), { ok: false, error: 'bad_amount' }, String(bad));
  }
});

test('parseQuoteInput takes the four chains only', () => {
  const ok = parseQuoteInput({ chain: 'base', amount: '10' });
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.input.origin.label, 'Base');
  assert.equal(ok.ok && ok.input.units, 10_000_000n);
  for (const chain of [undefined, 'near', 'btc', 'SOL', 'Solana', 1]) assert.deepEqual(parseQuoteInput({ chain, amount: '10' }), { ok: false, error: 'bad_chain' });
  assert.deepEqual(parseQuoteInput(null), { ok: false, error: 'bad_chain' });
  assert.deepEqual(parseQuoteInput({ chain: 'sol', amount: 'x' }), { ok: false, error: 'bad_amount' });
});

test('bad input is a 400 with a plain sentence, and 1Click is not called', async () => {
  const { fetch, calls } = oneClick();
  const cases: [unknown, string, string][] = [
    [{ chain: 'doge', amount: '25' }, 'bad_chain', 'Pick the chain your USDC is on.'],
    [{ chain: 'sol', amount: 'lots' }, 'bad_amount', 'Enter an amount in USDC, like 25.'],
    [{ chain: 'sol', amount: '0.5' }, 'too_small', 'Enter at least 1 USDC.'],
    [{ chain: 'sol', amount: '250000' }, 'too_large', 'Enter at most 100,000 USDC.'],
    [null, 'bad_chain', 'Pick the chain your USDC is on.'],
  ];
  for (const [body, error, message] of cases) {
    const r = await handleIntentsQuote(deps(fetch), body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error, message });
  }
  assert.equal(calls.length, 0);
});

// --------------------------------------------------------------- response

test('the recorded quote parses into the preview', () => {
  const route = findRoute(TOKENS, SOL)!;
  const p = parseQuoteResponse(QUOTE_201, { chain: 'sol', amount: '25000000', route, now: NOW });
  assert.deepEqual(p, {
    chain: 'sol',
    sendUnits: '25000000',
    receiveUnits: '24995618',
    minReceiveUnits: '24745661',
    feeUnits: '4382',
    timeSecs: 20,
    quotedAt: '2026-11-09T21:03:24.255Z',
  });
});

test('a quote with a deposit address, an echoed non-dry request or bad numbers is refused', () => {
  const route = findRoute(TOKENS, SOL)!;
  const ctx = { chain: 'sol' as const, amount: '25000000', route, now: NOW };
  const withQuote = (q: Record<string, unknown>) => ({ ...QUOTE_201, quote: { ...QUOTE_201.quote, ...q } });
  assert.throws(() => parseQuoteResponse(withQuote({ depositAddress: '0x76b4' }), ctx), BadQuoteResponse);
  assert.throws(() => parseQuoteResponse({ ...QUOTE_201, quoteRequest: { ...QUOTE_201.quoteRequest, dry: false } }, ctx), BadQuoteResponse);
  assert.throws(() => parseQuoteResponse(withQuote({ amountOut: '24.99' }), ctx), BadQuoteResponse);
  assert.throws(() => parseQuoteResponse(withQuote({ minAmountOut: undefined }), ctx), BadQuoteResponse);
  assert.throws(() => parseQuoteResponse(withQuote({ timeEstimate: '20' }), ctx), BadQuoteResponse);
  assert.throws(() => parseQuoteResponse(withQuote({ timeEstimate: -1 }), ctx), BadQuoteResponse);
  assert.throws(() => parseQuoteResponse(withQuote({ amountIn: '26000000' }), ctx), BadQuoteResponse);
  assert.throws(() => parseQuoteResponse({ message: 'x' }, ctx), BadQuoteResponse);
  assert.throws(() => parseQuoteResponse(null, ctx), BadQuoteResponse);
});

test('the fee is sent minus received and never negative; the time falls back to now', () => {
  const route = findRoute(TOKENS, SOL)!;
  const better = { ...QUOTE_201, timestamp: undefined, quote: { ...QUOTE_201.quote, amountOut: '25000100', minAmountOut: '24750000' } };
  const p = parseQuoteResponse(better, { chain: 'sol', amount: '25000000', route, now: NOW });
  assert.equal(p.feeUnits, '0');
  assert.equal(p.quotedAt, new Date(NOW).toISOString());
});

test('toUsdcUnits scales other decimals to 6, rounding down', () => {
  assert.equal(toUsdcUnits(25_000_000n, 6), 25_000_000n);
  assert.equal(toUsdcUnits(25n * 10n ** 18n + 999n, 18), 25_000_000n);
  assert.equal(toUsdcUnits(2_500_000_000n, 8), 25_000_000n);
  assert.equal(toUsdcUnits(250n, 1), 25_000_000n);
});

test('the handler returns the preview for the recorded quote', async () => {
  const { fetch } = oneClick();
  const r = await handleIntentsQuote(deps(fetch), { chain: 'sol', amount: '25' });
  assert.equal(r.status, 200);
  assert.equal(r.body.preview, true);
  assert.deepEqual(r.body.recipient, { kind: 'placeholder', accountId: PREVIEW_RECIPIENT });
  assert.equal((r.body.quote as { receiveUnits: string }).receiveUnits, '24995618');
  assert.equal((r.body.quote as { feeUnits: string }).feeUnits, '4382');
});

test('a quote that is not dry after all is a 502, not a preview', async () => {
  const { fetch } = oneClick({ status: 201, json: { ...QUOTE_201, quote: { ...QUOTE_201.quote, depositAddress: '0x76b4' } } });
  const r = await handleIntentsQuote(deps(fetch), { chain: 'sol', amount: '25' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'upstream');
});

// --------------------------------------------------------------- failures

test('classifyQuoteFailure sorts the recorded refusals', () => {
  assert.deepEqual(classifyQuoteFailure(400, TOO_LOW_400), { code: 'too_small', minUnits: null });
  assert.deepEqual(classifyQuoteFailure(400, { message: 'Amount is too low for bridge, try at least 1500000' }), { code: 'too_small', minUnits: 1_500_000n });
  assert.deepEqual(classifyQuoteFailure(400, BAD_TOKEN_400), { code: 'unavailable' });
  assert.deepEqual(classifyQuoteFailure(400, NO_RECIPIENT_400), { code: 'unavailable' });
  assert.deepEqual(classifyQuoteFailure(400, null), { code: 'unavailable' });
  assert.deepEqual(classifyQuoteFailure(429, {}), { code: 'busy' });
  assert.deepEqual(classifyQuoteFailure(401, {}), { code: 'upstream' });
  assert.deepEqual(classifyQuoteFailure(503, null), { code: 'upstream' });
});

test('1Click refusals come back as plain sentences', async () => {
  const cases: [{ status: number; json: unknown }, number, string, string][] = [
    [{ status: 400, json: TOO_LOW_400 }, 422, 'too_small', 'That is too little to send from Solana. Try a larger amount.'],
    [{ status: 400, json: { message: 'Amount is too low for bridge, try at least 1500000' } }, 422, 'too_small', 'That is too little to send from Solana. Try at least 1.50 USDC.'],
    [{ status: 400, json: BAD_TOKEN_400 }, 422, 'unavailable', "USDC can't come over from Solana right now. Try another chain."],
    [{ status: 429, json: {} }, 503, 'busy', 'Too many price checks just now. Try again in a minute.'],
    [{ status: 500, json: 'oops' }, 502, 'upstream', 'Live prices are unavailable right now. Try again later.'],
  ];
  for (const [reply, status, error, message] of cases) {
    const { fetch } = oneClick(reply);
    const r = await handleIntentsQuote(deps(fetch), { chain: 'sol', amount: '25' });
    assert.equal(r.status, status, message);
    assert.equal(r.body.error, error);
    assert.equal(r.body.message, message);
  }
});

test('a chain missing from the tokens list is unavailable, without a quote', async () => {
  const fetch = fakeFetch((url) => (url.endsWith('/v0/tokens') ? { status: 200, json: TOKENS_JSON.filter((t) => t.blockchain !== 'arb') } : { status: 201, json: QUOTE_201 }));
  const r = await handleIntentsQuote(deps(fetch.fetch), { chain: 'arb', amount: '25' });
  assert.equal(r.status, 422);
  assert.equal(r.body.message, "USDC can't come over from Arbitrum right now. Try another chain.");
  assert.equal(quoteBodies(fetch.calls).length, 0);
});

test('findRoute picks USDC by asset id, not a look-alike', () => {
  const base = findRoute(TOKENS, originByChain('base')!)!;
  assert.equal(base.origin.symbol, 'USDC');
  assert.equal(base.origin.assetId, 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near');
  assert.equal(base.destination.assetId, NEAR_USDC_ASSET);
  assert.equal(findRoute(TOKENS.filter((t) => t.blockchain !== 'near'), SOL), null);
});

// A fetch that never answers until it is aborted.
const hanging: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

test('a quote that takes too long times out as a 504', async () => {
  const fetch: FetchLike = (url, init) => (url.endsWith('/v0/tokens') ? Promise.resolve({ status: 200, text: async () => JSON.stringify(TOKENS_JSON) }) : hanging(url, init));
  const t0 = Date.now();
  const r = await handleIntentsQuote(deps(fetch, { timeoutMs: 30 }), { chain: 'sol', amount: '25' });
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(r.status, 504);
  assert.deepEqual(r.body, { error: 'timeout', message: 'Getting a price took too long. Try again.' });
  await assert.rejects(postQuote({ fetch: hanging, timeoutMs: 20 }, buildDryQuoteRequest({ origin: SOL, units: 25_000_000n }, NOW)), IntentsTimeout);
});

test('a network failure is a 502', async () => {
  const fetch: FetchLike = async (url) => {
    if (url.endsWith('/v0/tokens')) return { status: 200, text: async () => JSON.stringify(TOKENS_JSON) };
    throw new Error('fetch failed');
  };
  const r = await handleIntentsQuote(deps(fetch), { chain: 'sol', amount: '25' });
  assert.equal(r.status, 502);
});

// ------------------------------------------------------------- token list

test('the tokens list is cached for its TTL and fetched once at a time', async () => {
  let now = NOW;
  const { fetch, calls } = fakeFetch(() => ({ status: 200, json: TOKENS_JSON }));
  const cache = createTokenCache({ fetch, now: () => now, ttlMs: 60_000 });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(calls.length, 1);
  assert.equal(a, b);
  now += 59_000;
  await cache.get();
  assert.equal(calls.length, 1);
  now += 2_000;
  await cache.get();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://1click.chaindefuser.com/v0/tokens');
});

test('a failed refresh serves the last list for an hour, then fails', async () => {
  let now = NOW;
  let up = true;
  const { fetch } = fakeFetch(() => (up ? { status: 200, json: TOKENS_JSON } : { status: 503, json: null }));
  const cache = createTokenCache({ fetch, now: () => now, ttlMs: 60_000, maxStaleMs: 3_600_000 });
  const first = await cache.get();
  up = false;
  now += 120_000;
  assert.equal(await cache.get(), first);
  now += 3_600_000;
  await assert.rejects(cache.get());
});

test('no tokens list at all is a 502 for the quote', async () => {
  const { fetch } = fakeFetch(() => ({ status: 503, json: null }));
  const r = await handleIntentsQuote(deps(fetch), { chain: 'sol', amount: '25' });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'upstream');
});

test('parseTokens keeps well-formed entries only', () => {
  const t: IntentsToken[] = parseTokens([...TOKENS_JSON, { assetId: 'x' }, null, { assetId: 'y', decimals: 1.5, blockchain: 'near', symbol: 'Y' }]);
  assert.equal(t.length, TOKENS_JSON.length);
  assert.throws(() => parseTokens({ tokens: [] }));
});

// ------------------------------------------------------------- formatting

test('amounts, fees and times read plainly', () => {
  assert.equal(fmtUsdc('25000000'), '25.00');
  assert.equal(fmtUsdc('24995618'), '24.9956');
  assert.equal(fmtUsdc(24_500_000n), '24.50');
  assert.equal(fmtUsdc(1_234_567_890_000n), '1,234,567.89');
  assert.equal(fmtFee('4382'), '0.0044 USDC');
  assert.equal(fmtFee(1_500_000n), '1.50 USDC');
  assert.equal(fmtFee(50n), 'under 0.0001 USDC');
  assert.equal(fmtFee('0'), 'none');
  assert.equal(fmtDuration(20), 'About 20 seconds');
  assert.equal(fmtDuration(1), 'About 1 second');
  assert.equal(fmtDuration(0), 'About 1 second');
  assert.equal(fmtDuration(45), 'About 45 seconds');
  assert.equal(fmtDuration(120), 'About 2 minutes');
  assert.equal(fmtDuration(3_600), 'About 1 hour');
});
