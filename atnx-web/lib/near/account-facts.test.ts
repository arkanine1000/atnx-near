import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceLine, keyPermission, keysLine, nearAmount, readAccountFacts, relayerLine } from './account-facts';

const HOUSE_KEY = { FunctionCall: { receiver_id: 'house.atnx.testnet', method_names: [], allowance: '250000000000000000000000' } };

test('NEAR amounts, up to five decimals', () => {
  assert.equal(nearAmount('0'), '0');
  assert.equal(nearAmount(250_000_000_000_000_000_000_000n), '0.25');
  assert.equal(nearAmount('12500000000000000000000000'), '12.5');
  assert.equal(nearAmount('1234567890000000000000000'), '1.23456');
  assert.equal(nearAmount('1000'), 'less than 0.00001');
  assert.equal(balanceLine('0'), 'Holds 0 NEAR.');
});

test('permissions in the RPC shape', () => {
  assert.equal(keyPermission('FullAccess'), 'FullAccess');
  assert.deepEqual(keyPermission(HOUSE_KEY), { receiverId: 'house.atnx.testnet', methodNames: [] });
  assert.equal(keyPermission({ Something: {} }), 'Unknown');
  assert.equal(keyPermission(null), 'Unknown');
});

test('a house account: one function-call key for the house contract', () => {
  assert.equal(keysLine([keyPermission(HOUSE_KEY)]), 'One key, which can only call house.atnx.testnet.');
});

test('a key with a method list names its methods', () => {
  const k = keyPermission({ FunctionCall: { receiver_id: 'rounds.atnx.testnet', method_names: ['commit', 'buy', 'claim'] } });
  assert.equal(keysLine([k]), 'One key, which can only call commit, buy and claim on rounds.atnx.testnet.');
  const many = keyPermission({ FunctionCall: { receiver_id: 'r.testnet', method_names: ['a', 'b', 'c', 'd', 'e', 'f'] } });
  assert.equal(keysLine([many]), 'One key, which can only call a, b, c and 3 more methods on r.testnet.');
});

test('anything else is said as it is', () => {
  assert.equal(keysLine([]), 'Has no access keys.');
  assert.equal(keysLine(['FullAccess']), 'One key, which has full access.');
  assert.equal(
    keysLine([keyPermission(HOUSE_KEY), 'FullAccess']),
    '2 keys: one can only call house.atnx.testnet; one has full access.',
  );
  assert.equal(keysLine(['Unknown']), 'One key, which is of a kind this page does not know.');
});

test('the relayer, named when known', () => {
  assert.equal(relayerLine('relayer.atnx.testnet'), 'relayer.atnx.testnet sends its calls and pays their gas.');
  assert.equal(relayerLine(null), "ATNX's relayer sends its calls and pays their gas.");
});

test('readAccountFacts reads view_account and view_access_key_list', async () => {
  const asked: string[] = [];
  const provider = {
    viewAccount: async ({ accountId }: { accountId: string }) => {
      asked.push(`account ${accountId}`);
      return { amount: 0n, locked: 0n } as never;
    },
    viewAccessKeyList: async ({ accountId }: { accountId: string }) => {
      asked.push(`keys ${accountId}`);
      return { keys: [{ public_key: 'ed25519:x', access_key: { nonce: 1, permission: HOUSE_KEY } }] } as never;
    },
  };
  const facts = await readAccountFacts(provider, 'guest-a-h.atnx.testnet');
  assert.deepEqual(asked.sort(), ['account guest-a-h.atnx.testnet', 'keys guest-a-h.atnx.testnet']);
  assert.equal(facts.amount, '0');
  assert.deepEqual(facts.keys, [{ receiverId: 'house.atnx.testnet', methodNames: [] }]);
});
