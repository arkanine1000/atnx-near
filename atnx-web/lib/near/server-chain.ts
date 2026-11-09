// The parent account's side of account creation, without Next or Supabase
// (lib/near/server.ts wires it into the route; the e2e script uses it
// directly). Server only: it holds the parent key.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions, nearToYocto, type Action, type KeyPairString } from 'near-api-js';
import { USER_METHODS } from './config';
import { rpcChainReader } from './relay';
import type { AccountChain } from './routes';

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

// The parent signs CreateAccount + AddKey for <handle>.<parent>: zero
// NEAR (a zero-balance account, under 770 bytes) and one key, the user's
// browser key, as a function-call key for the rounds contract and the user
// methods only. No custody key.
export function parentAccountChain(opts: { rpcUrl: string; parentId: string; parentKey: string; roundsId: string }): AccountChain & { spendable(): Promise<bigint> } {
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
  const parent = new Account(opts.parentId, provider, new KeyPairSigner(KeyPair.fromString(opts.parentKey as KeyPairString)));
  const reader = rpcChainReader(provider);
  return {
    async accountExists(accountId) {
      try {
        await provider.viewAccount({ accountId });
        return true;
      } catch (e) {
        if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String((e as Error)?.message ?? e))) return false;
        throw e;
      }
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
