// Seeds a house contract with test USDG, with no change to the token:
// the parent account (owner and treasury) takes USDG from the rounds
// faucet, withdraws it from the rounds ledger, sends it to the house with
// ft_transfer_call (the house accepts tokens from the treasury only), and
// deposits the vault's part.
//
//   npx tsx --env-file=.env.local scripts/house-seed.ts \
//     --contract house.atnx.testnet --vault 10000000 --faucet 2000000 [--live]
//
// Amounts are whole USDG. Dry by default: it prints the plan and sends
// nothing. It reads BM_NEAR_PARENT_SECRET and never prints it.

import { actions } from 'near-api-js';
import { nearAccount, nearProvider, parseNearSecret } from '../lib/bm/near';

const TGAS = 1_000_000_000_000n;
const UNIT = 1_000_000n; // USDG has 6 decimals
const FAUCET_MAX = 10_000n * UNIT; // the rounds faucet's cap per call
const FAUCETS_PER_TX = 25; // 25 calls of 30 TGas stay under the 1 PGas limit

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function view(contractId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  return nearProvider().callFunction({ contractId, method, args });
}

async function main() {
  const live = process.argv.includes('--live');
  const house = flag('--contract') ?? 'house.atnx.testnet';
  const vault = BigInt(flag('--vault') ?? '0') * UNIT;
  const faucet = BigInt(flag('--faucet') ?? '0') * UNIT;
  const parentId = process.env.BM_NEAR_PARENT_ACCOUNT?.trim() || 'atnx.testnet';
  const rounds = process.env.NEXT_PUBLIC_BM_NEAR_ROUNDS?.trim() || 'rounds.atnx.testnet';
  const usdg = process.env.NEXT_PUBLIC_BM_NEAR_USDG?.trim() || 'usdg.atnx.testnet';
  const total = vault + faucet;
  if (total <= 0n) throw new Error('nothing to seed: give --vault and/or --faucet in whole USDG');

  const tokenBalance = BigInt(String(await view(usdg, 'ft_balance_of', { account_id: parentId })));
  const roundsBalance = BigInt(String(await view(rounds, 'balance_of', { account_id: parentId })));
  const missing = total > tokenBalance + roundsBalance ? total - tokenBalance - roundsBalance : 0n;
  const calls = Number((missing + FAUCET_MAX - 1n) / FAUCET_MAX);
  const toWithdraw = total > tokenBalance ? total - tokenBalance : 0n;
  console.log(`house ${house}, parent ${parentId}${live ? '' : ' (dry run)'}`);
  console.log(`  to seed: vault ${vault / UNIT} + faucet pool ${faucet / UNIT} = ${total / UNIT} USDG`);
  console.log(`  parent holds ${tokenBalance / UNIT} USDG in tokens and ${roundsBalance / UNIT} in the rounds ledger`);
  console.log(`  plan: ${calls} faucet calls in ${Math.ceil(calls / FAUCETS_PER_TX)} transactions, withdraw ${toWithdraw / UNIT}, two transfers, one deposit`);
  if (!live) return;

  const parent = nearAccount(parentId, parseNearSecret(process.env.BM_NEAR_PARENT_SECRET, 'BM_NEAR_PARENT_SECRET'));
  const send = async (receiverId: string, acts: ReturnType<typeof actions.functionCall>[], what: string) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await parent.signAndSendTransaction({ receiverId, actions: acts, waitUntil: 'FINAL' });
        return out;
      } catch (err) {
        if (attempt >= 4) throw new Error(`${what}: ${(err as Error).message}`);
        console.log(`  ${what}: retry ${attempt} after ${(err as Error).message.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
  };

  let left = calls;
  let done = 0;
  while (left > 0) {
    const n = Math.min(left, FAUCETS_PER_TX);
    const acts = Array.from({ length: n }, () => actions.functionCall('faucet', { amount: FAUCET_MAX.toString() }, 30n * TGAS, 0n));
    await send(rounds, acts, 'faucet');
    left -= n;
    done += n;
    if (done % 100 === 0 || left === 0) console.log(`  faucet calls done: ${done} of ${calls}`);
  }
  if (toWithdraw > 0n) {
    await send(rounds, [actions.functionCall('withdraw', { amount: toWithdraw.toString() }, 60n * TGAS, 0n)], 'withdraw');
    console.log(`  withdrawn ${toWithdraw / UNIT} USDG from the rounds ledger`);
  }
  if (vault > 0n) {
    await send(usdg, [actions.functionCall('ft_transfer_call', { receiver_id: house, amount: vault.toString(), msg: '' }, 100n * TGAS, 1n)], 'vault transfer');
    await send(house, [actions.functionCall('lp_deposit', { amount: vault.toString() }, 30n * TGAS, 0n)], 'lp_deposit');
    console.log(`  vault: ${vault / UNIT} USDG deposited`);
  }
  if (faucet > 0n) {
    await send(usdg, [actions.functionCall('ft_transfer_call', { receiver_id: house, amount: faucet.toString(), msg: 'faucet' }, 100n * TGAS, 1n)], 'faucet pool transfer');
    console.log(`  faucet pool: ${faucet / UNIT} USDG added`);
  }
  const v = (await view(house, 'get_vault', {})) as Record<string, unknown>;
  const held = BigInt(String(await view(usdg, 'ft_balance_of', { account_id: house })));
  console.log(`  house now: assets ${v.assets}, faucet_pool ${v.faucet_pool}, reserved ${v.reserved}; tokens held ${held}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
