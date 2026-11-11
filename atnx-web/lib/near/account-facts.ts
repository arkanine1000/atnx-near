// What Settings says about a trader's NEAR account behind its "?": the
// NEAR it holds and the keys it has, read from public RPC when the window
// opens (view_account and view_access_key_list), and who sends its calls.
// The words are worked out here from what the RPC answers, so an account
// with a balance, more keys or another kind of key says so.
import type { JsonRpcProvider } from 'near-api-js';

const YOCTO_PER_NEAR = 10n ** 24n;

export type FactKeyPermission = 'FullAccess' | { receiverId: string; methodNames: string[] } | 'Unknown';

export interface AccountFactsRead {
  // yoctoNEAR, as view_account gives it.
  amount: string;
  keys: FactKeyPermission[];
}

// view_access_key_list's permission, in either of the shapes the RPC uses.
export function keyPermission(p: unknown): FactKeyPermission {
  if (p === 'FullAccess') return 'FullAccess';
  const fc = (p as { FunctionCall?: { receiver_id?: unknown; method_names?: unknown } } | null)?.FunctionCall;
  if (fc && typeof fc.receiver_id === 'string') {
    return { receiverId: fc.receiver_id, methodNames: Array.isArray(fc.method_names) ? fc.method_names.map(String) : [] };
  }
  return 'Unknown';
}

// NEAR from yoctoNEAR, up to five decimals: "0", "0.25", "12.5".
export function nearAmount(yocto: string | bigint): string {
  const y = BigInt(yocto);
  const whole = y / YOCTO_PER_NEAR;
  const frac = (y % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, 5).replace(/0+$/, '');
  if (whole === 0n && !frac && y > 0n) return 'less than 0.00001';
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function balanceLine(yocto: string | bigint): string {
  return `Holds ${nearAmount(yocto)} NEAR.`;
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// What one key may do: "can only call house.atnx.testnet", "can only call
// commit and buy on rounds.atnx.testnet", "has full access".
function keyClause(k: FactKeyPermission): string {
  if (k === 'FullAccess') return 'has full access';
  if (k === 'Unknown') return 'is of a kind this page does not know';
  const methods = k.methodNames.length > 4 ? [...k.methodNames.slice(0, 3), `${k.methodNames.length - 3} more methods`] : k.methodNames;
  return methods.length ? `can only call ${listWords(methods)} on ${k.receiverId}` : `can only call ${k.receiverId}`;
}

export function keysLine(keys: FactKeyPermission[]): string {
  if (keys.length === 0) return 'Has no access keys.';
  if (keys.length === 1) return `One key, which ${keyClause(keys[0])}.`;
  return `${keys.length} keys: ${keys.map((k) => `one ${keyClause(k)}`).join('; ')}.`;
}

// Who sends the account's calls. The relayer's account is named when the
// server knows it.
export function relayerLine(relayerId: string | null | undefined): string {
  return relayerId ? `${relayerId} sends its calls and pays their gas.` : "ATNX's relayer sends its calls and pays their gas.";
}

export async function readAccountFacts(provider: Pick<JsonRpcProvider, 'viewAccount' | 'viewAccessKeyList'>, accountId: string): Promise<AccountFactsRead> {
  const [account, list] = await Promise.all([provider.viewAccount({ accountId }), provider.viewAccessKeyList({ accountId })]);
  const keys = ((list as unknown as { keys?: Array<{ access_key?: { permission?: unknown } }> }).keys ?? []).map((k) => keyPermission(k.access_key?.permission));
  return { amount: String((account as unknown as { amount: string | bigint }).amount), keys };
}
