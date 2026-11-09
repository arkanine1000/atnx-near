import { NEAR_ROUNDS, NEAR_RPC, isNearChain } from '@/lib/near/config';
import { findNearRoundForVerify } from '@/lib/near/registry';
import { handleVerify } from '@/lib/near/verify';

// GET /api/near/rounds/verify?series=<on-chain series id>&round=<n>
//   -> 200 { series, round, contract, rpc, market, settleInputs, canonical,
//            registryCommitment, onchain: { state, commitment, targetE2,
//            settleE2, closeAt, winner, reference, settleWindowSecs },
//            recomputed, match, registryMatch, ok, problems, settleTx,
//            settleTxUrl, verifyLocally }
//   -> 400 bad_request, 404 not_in_registry | not_on_chain, 409 not_settled
// A settled NEAR round's oracle commitment, checked: the registry's
// canonical settle inputs (bm.rounds.settle_inputs), the commitment the
// registry recorded, the round's commitment read live from the rounds
// contract over public RPC, and the sha256 of the inputs recomputed here.
// `match` is recomputed === on-chain. Public, read only, no secrets; the
// same check runs anywhere with `npm run rounds:verify:public` (which hashes
// the inputs itself). NEAR build only.

const HEADERS = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };

export async function GET(request: Request) {
  if (!isNearChain() || !NEAR_ROUNDS) return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const r = await handleVerify(
      { findRound: findNearRoundForVerify, chain: { fetch: (url, init) => fetch(url, init), rpcUrl: NEAR_RPC, contractId: NEAR_ROUNDS } },
      new URL(request.url).searchParams,
    );
    return Response.json(r.body, { status: r.status, headers: HEADERS });
  } catch (err) {
    console.error('[near/rounds/verify]', (err as Error)?.message ?? err);
    return Response.json({ error: 'server_error' }, { status: 500, headers: HEADERS });
  }
}
