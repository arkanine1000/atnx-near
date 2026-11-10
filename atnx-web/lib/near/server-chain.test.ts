import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAccessKeys } from './server-chain';

// A provider that answers view_access_key_list the way the RPC does: an
// empty list for an account that is not there.
function fakeProvider(accounts: Record<string, Array<{ public_key: string; access_key: { permission: unknown } }>>) {
  return {
    async viewAccessKeyList({ accountId }: { accountId: string }) {
      return { keys: accounts[accountId] ?? [] };
    },
    async viewAccount({ accountId }: { accountId: string }) {
      if (!(accountId in accounts)) throw new Error(`account ${accountId} does not exist while viewing`);
      return {};
    },
  } as unknown as Parameters<typeof readAccessKeys>[0];
}

const KEY = 'ed25519:3KE2u88TYedJNuPSnw16BYRhz4aC4cn49mobHuPZFjmh';

test('readAccessKeys: an account that is not there is null, not an empty list', async () => {
  assert.equal(await readAccessKeys(fakeProvider({}), 'guest-abc-h.atnx.testnet'), null);
});

test('readAccessKeys: an account with no key is an empty list', async () => {
  assert.deepEqual(await readAccessKeys(fakeProvider({ 'bob-h.atnx.testnet': [] }), 'bob-h.atnx.testnet'), []);
});

test('readAccessKeys: the keys of an account that is there', async () => {
  const keys = await readAccessKeys(
    fakeProvider({
      'bob-h.atnx.testnet': [{ public_key: KEY, access_key: { permission: { FunctionCall: { allowance: '1', receiver_id: 'house.atnx.testnet', method_names: [] } } } }],
    }),
    'bob-h.atnx.testnet',
  );
  assert.equal(keys?.length, 1);
  assert.equal(keys?.[0].publicKey, KEY);
  assert.notEqual(keys?.[0].permission, 'FullAccess');
});

test('readAccessKeys: a list call that fails for a missing account is null', async () => {
  const provider = {
    async viewAccessKeyList() {
      throw new Error('UNKNOWN_ACCOUNT');
    },
    async viewAccount() {
      throw new Error('UNKNOWN_ACCOUNT');
    },
  } as unknown as Parameters<typeof readAccessKeys>[0];
  assert.equal(await readAccessKeys(provider, 'x-h.atnx.testnet'), null);
});
