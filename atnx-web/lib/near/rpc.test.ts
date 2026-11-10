import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner, actions, baseEncode, base64Encode, createTransaction, encodeTransaction } from 'near-api-js';
import { isRetryableRpcError, redactRpcError, rpcProvider, sentTransaction, type RpcEndpointClient } from './rpc';
import { parseRpcUrls, rpcHost, serverRpcUrls } from './rpc-urls';

// An error as near-api-js throws it for an HTTP status (ProviderError).
function httpError(status: number, message = `HTTP ${status}`): Error {
  const e = new Error(message) as Error & { cause: number };
  e.cause = status;
  return e;
}

// Fake endpoints: each answers by a handler and records what it was asked.
function fakes(handlers: Record<string, (method: string, params: unknown) => unknown>) {
  const calls: Array<{ url: string; method: string }> = [];
  const make = (url: string): RpcEndpointClient => ({
    async sendJsonRpc(method, params) {
      calls.push({ url, method });
      const h = handlers[url];
      if (!h) throw new Error('no handler');
      return h(method, params);
    },
  });
  return { calls, make };
}

const A = 'https://a.example/rpc';
const B = 'https://b.example/v1/SECRETKEY';
const logs: string[] = [];
const log = (l: string) => logs.push(l);

test('parseRpcUrls: a comma-separated list, trimmed, http(s) only, no repeats', () => {
  assert.deepEqual(parseRpcUrls(' https://a.example , https://b.example/x,,ftp://c.example, nonsense, https://a.example '), ['https://a.example', 'https://b.example/x']);
  assert.deepEqual(parseRpcUrls(''), []);
  assert.deepEqual(parseRpcUrls(undefined), []);
});

test('serverRpcUrls: BM_NEAR_RPC, then NEXT_PUBLIC_BM_NEAR_RPC, then the default', () => {
  assert.deepEqual(serverRpcUrls({ BM_NEAR_RPC: `${A},${B}`, NEXT_PUBLIC_BM_NEAR_RPC: 'https://p.example' }), [A, B]);
  assert.deepEqual(serverRpcUrls({ NEXT_PUBLIC_BM_NEAR_RPC: 'https://p.example' }), ['https://p.example']);
  assert.deepEqual(serverRpcUrls({}), ['https://test.rpc.fastnear.com']);
});

test('isRetryableRpcError: the endpoint\'s trouble, not the chain\'s answers', () => {
  assert.equal(isRetryableRpcError(httpError(429, '{"error":{"code":-429,"message":"Rate limits exceeded"}}')), true);
  assert.equal(isRetryableRpcError(httpError(503)), true);
  assert.equal(isRetryableRpcError(new TypeError('fetch failed')), true);
  assert.equal(isRetryableRpcError(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryableRpcError(new Error('Exceeded 12 attempts for request to query.')), true);
  assert.equal(isRetryableRpcError(new Error('account guest-x.atnx.testnet does not exist while viewing')), false);
  assert.equal(isRetryableRpcError(new Error('Smart contract panicked: position 429 not found')), false);
  assert.equal(isRetryableRpcError(null), false);
});

test('a read moves to the next endpoint when one is rate limited, and that one rests', async () => {
  let t = 1_000;
  const { calls, make } = fakes({
    [A]: () => {
      throw httpError(429, 'Rate limits exceeded');
    },
    [B]: () => ({ ok: 'b' }),
  });
  logs.length = 0;
  const p = rpcProvider([A, B], { make, log, now: () => t });
  assert.deepEqual(await p.sendJsonRpc('block' as never, { finality: 'final' } as never), { ok: 'b' });
  assert.deepEqual(await p.sendJsonRpc('block' as never, { finality: 'final' } as never), { ok: 'b' });
  assert.deepEqual(
    calls.map((c) => c.url),
    [A, B, B],
  );
  // The log names hosts, never the keyed path.
  assert.equal(logs.length, 1);
  assert.match(logs[0], /a\.example: rate limited; trying b\.example/);
  assert.doesNotMatch(logs.join('\n'), /SECRETKEY/);
  // After its rest, the first endpoint is asked first again.
  t += 31_000;
  await p.sendJsonRpc('block' as never, {} as never);
  assert.equal(calls.at(-2)?.url, A);
});

test('an answer from the chain comes back as it is, from the first endpoint', async () => {
  const { calls, make } = fakes({
    [A]: () => {
      throw new Error('account x.atnx.testnet does not exist while viewing');
    },
    [B]: () => ({}),
  });
  const p = rpcProvider([A, B], { make, log });
  await assert.rejects(() => p.sendJsonRpc('query' as never, {} as never), /does not exist/);
  assert.deepEqual(
    calls.map((c) => c.url),
    [A],
  );
});

test('errors name the host, not a keyed URL', async () => {
  const { make } = fakes({
    [A]: () => {
      throw httpError(502, `${A} Bad Gateway`);
    },
    [B]: () => {
      throw httpError(503, `${B} unavailable`);
    },
  });
  const p = rpcProvider([A, B], { make, log });
  await assert.rejects(
    () => p.sendJsonRpc('query' as never, {} as never),
    (err: Error) => /b\.example unavailable/.test(err.message) && !/SECRETKEY/.test(err.message) && !/SECRETKEY/.test(String(err.stack)),
  );
  const e = redactRpcError(new Error(`at ${B}/`), [B]);
  assert.equal(e.message, 'at b.example/');
  assert.equal(rpcHost(B), 'b.example');
});

async function signedTx(): Promise<{ b64: string; hash: string; signerId: string }> {
  const key = KeyPair.fromRandom('ed25519');
  const signer = new KeyPairSigner(key);
  const tx = createTransaction('relayer.atnx.testnet', key.getPublicKey(), 'guest-a-h.atnx.testnet', 7n, [actions.transfer(1n)], new Uint8Array(32));
  const { txHash, signedTransaction } = await signer.signTransaction(tx);
  return { b64: base64Encode(encodeTransaction(signedTransaction)), hash: baseEncode(txHash), signerId: 'relayer.atnx.testnet' };
}

test('sentTransaction: the hash and signer of a send', async () => {
  const s = await signedTx();
  assert.deepEqual(await sentTransaction('send_tx', { signed_tx_base64: s.b64, wait_until: 'FINAL' }), { hash: s.hash, signerId: s.signerId });
  assert.equal(await sentTransaction('send_tx', { signed_tx_base64: 'not base64 at all' }), null);
});

test('a send refused by a rate limit is looked up by hash, then sent to the next endpoint', async () => {
  const s = await signedTx();
  const asked: Array<{ method: string; params: unknown }> = [];
  const { calls, make } = fakes({
    [A]: () => {
      throw httpError(429, 'Rate limits exceeded');
    },
    [B]: (method, params) => {
      asked.push({ method, params });
      if (method === 'tx') throw new Error('Transaction doesn\'t exist (UNKNOWN_TRANSACTION)');
      return { status: { SuccessValue: '' }, transaction: { hash: s.hash } };
    },
  });
  const p = rpcProvider([A, B], { make, log });
  const res = (await p.sendJsonRpc('send_tx' as never, { signed_tx_base64: s.b64, wait_until: 'EXECUTED_OPTIMISTIC' } as never)) as { transaction: { hash: string } };
  assert.equal(res.transaction.hash, s.hash);
  assert.deepEqual(
    calls.map((c) => `${c.url} ${c.method}`),
    [`${A} send_tx`, `${B} tx`, `${B} send_tx`],
  );
  assert.deepEqual(asked[0].params, { tx_hash: s.hash, sender_account_id: s.signerId, wait_until: 'EXECUTED_OPTIMISTIC' });
});

test('a send that failed but landed is not sent again', async () => {
  const s = await signedTx();
  const { calls, make } = fakes({
    [A]: () => {
      throw new TypeError('fetch failed');
    },
    [B]: (method) => {
      if (method === 'tx') return { status: { SuccessValue: '' }, transaction: { hash: s.hash }, final_execution_status: 'EXECUTED_OPTIMISTIC' };
      throw new Error('must not be sent again');
    },
  });
  const p = rpcProvider([A, B], { make, log });
  const res = (await p.sendJsonRpc('send_tx' as never, { signed_tx_base64: s.b64, wait_until: 'EXECUTED_OPTIMISTIC' } as never)) as { transaction: { hash: string } };
  assert.equal(res.transaction.hash, s.hash);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['send_tx', 'tx'],
  );
});

test('a second send refused with an invalid nonce, but found by hash after all, counts as landed', async () => {
  const s = await signedTx();
  let lookups = 0;
  const { make } = fakes({
    [A]: () => {
      throw httpError(503);
    },
    [B]: (method) => {
      if (method === 'tx') {
        lookups++;
        if (lookups === 1) throw new Error('UNKNOWN_TRANSACTION');
        return { transaction: { hash: s.hash } };
      }
      throw new Error('InvalidNonce');
    },
  });
  const p = rpcProvider([A, B], { make, log });
  const res = (await p.sendJsonRpc('send_tx' as never, { signed_tx_base64: s.b64 } as never)) as { transaction: { hash: string } };
  assert.equal(res.transaction.hash, s.hash);
});

test('a send the chain refuses is passed on as it is, with no second endpoint', async () => {
  const s = await signedTx();
  const { calls, make } = fakes({
    [A]: () => {
      throw new Error('InvalidNonce');
    },
    [B]: () => ({}),
  });
  const p = rpcProvider([A, B], { make, log });
  await assert.rejects(() => p.sendJsonRpc('send_tx' as never, { signed_tx_base64: s.b64 } as never), /InvalidNonce/);
  assert.equal(calls.length, 1);
});

test('one endpoint: no failover, and the error keeps its kind', async () => {
  const { calls, make } = fakes({
    [A]: () => {
      throw httpError(429, 'Rate limits exceeded');
    },
  });
  const p = rpcProvider([A], { make, log });
  await assert.rejects(
    () => p.sendJsonRpc('query' as never, {} as never),
    (err: Error & { cause?: unknown }) => err.cause === 429,
  );
  assert.equal(calls.length, 1);
});
