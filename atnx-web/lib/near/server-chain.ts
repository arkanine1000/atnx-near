// The parent account's side of account creation, without Next or Supabase
// (lib/near/server.ts wires it into the route; the e2e script uses it
// directly). Server only: it holds the parent key.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions, nearToYocto, type Action, type KeyPairString } from 'near-api-js';
import { USER_METHODS } from './config';
import type { AccountKey } from './house-account';
import { normalisePermission, rpcChainReader } from './relay';
import type { AccountChain, HouseAccountChain } from './routes';

// The function-call key's allowance. The relayer pays all gas, so it never
// drains; it caps what the key could spend if NEAR ever landed on the
// account. The prototype ran with the same.
export const KEY_ALLOWANCE = nearToYocto('0.25');

// The parent's one transaction for a new account, user or guest:
// CreateAccount, then the browser's key as a function-call key for the
// rounds contract and the user methods. No Transfer (the account holds zero
// NEAR) and no full-access key.
export function accountCreationActions(publicKey: string, roundsId: string): Action[] {
  return [actions.createAccount(), actions.addFunctionCallAccessKey(PublicKey.from(publicKey), roundsId, [...USER_METHODS], KEY_ALLOWANCE)];
}

// The same for a house account (<handle>-h.<parent>): CreateAccount, then
// the same browser key as a function-call key for the house contract with
// an empty method list (the relayer's method list is the gate), the same
// allowance. No Transfer and no full-access key.
export function houseAccountCreationActions(publicKey: string, houseId: string): Action[] {
  return [actions.createAccount(), actions.addFunctionCallAccessKey(PublicKey.from(publicKey), houseId, [], KEY_ALLOWANCE)];
}

const MISSING_ACCOUNT = /does not exist|UNKNOWN_ACCOUNT|doesn't exist/i;

type KeyListProvider = Pick<JsonRpcProvider, 'viewAccessKeyList' | 'viewAccount'>;

async function accountExistsOn(provider: Pick<JsonRpcProvider, 'viewAccount'>, accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch (e) {
    if (MISSING_ACCOUNT.test(String((e as Error)?.message ?? e))) return false;
    throw e;
  }
}

// An account's access keys, or null when the account does not exist. The
// RPC answers view_access_key_list with an empty list for an account that
// is not there, so an empty list is checked against the account itself: an
// account that exists with no key is an empty list, a missing one null.
export async function readAccessKeys(provider: KeyListProvider, accountId: string): Promise<AccountKey[] | null> {
  let list: { keys?: Array<{ public_key: string; access_key: { permission: unknown } }> };
  try {
    list = (await provider.viewAccessKeyList({ accountId })) as unknown as typeof list;
  } catch (e) {
    if (MISSING_ACCOUNT.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
  // A kind of key this code does not know reads as full access: never
  // something to reuse.
  const permission = (p: unknown) => {
    try {
      return normalisePermission(p);
    } catch {
      return 'FullAccess' as const;
    }
  };
  const keys = (list.keys ?? []).map((k) => ({ publicKey: String(k.public_key), permission: permission(k.access_key.permission) }));
  if (keys.length === 0 && !(await accountExistsOn(provider, accountId))) return null;
  return keys;
}

// The parent signs CreateAccount + AddKey for <handle>.<parent>: zero
// NEAR (a zero-balance account, under 770 bytes) and one key, the user's
// browser key, as a function-call key for the rounds contract and the user
// methods only. No custody key. With `houseId`, it also makes house
// accounts (createHouseAccount) and lists an account's keys (accessKeys).
export function parentAccountChain(opts: {
  rpcUrl: string;
  parentId: string;
  parentKey: string;
  roundsId: string;
  houseId?: string;
}): AccountChain & HouseAccountChain & { spendable(): Promise<bigint> } {
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
  const parent = new Account(opts.parentId, provider, new KeyPairSigner(KeyPair.fromString(opts.parentKey as KeyPairString)));
  const reader = rpcChainReader(provider);
  return {
    accountExists: (accountId) => accountExistsOn(provider, accountId),
    accessKeys: (accountId) => readAccessKeys(provider, accountId),
    async createHouseAccount({ accountId, publicKey }) {
      if (!opts.houseId) throw new Error('house accounts are not configured');
      const res = await parent.signAndSendTransaction({
        receiverId: accountId,
        actions: houseAccountCreationActions(publicKey, opts.houseId),
        waitUntil: 'FINAL',
      });
      return { txHash: res.transaction.hash };
    },
    async hasKey(accountId, publicKey) {
      return !!(await reader.accessKey(accountId, publicKey));
    },
    async createAccount({ accountId, publicKey }) {
      const res = await parent.signAndSendTransaction({
        receiverId: accountId,
        actions: accountCreationActions(publicKey, opts.roundsId),
        // Final, so the key is there when the browser signs its first call.
        waitUntil: 'FINAL',
      });
      return { txHash: res.transaction.hash };
    },
    // What the parent can still spend on accounts, in yoctoNEAR.
    async spendable() {
      return BigInt((await parent.getState()).balance.available);
    },
  };
}
