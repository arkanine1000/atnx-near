import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestAccountId } from './guest';
import { handleCandidates, pickAccountId, randomHandle } from './handle';
import { houseAccountId, isReservedHandle } from './house-account';

test('houseAccountId: "-h" goes before the parent', () => {
  assert.equal(houseAccountId('alice.atnx.testnet'), 'alice-h.atnx.testnet');
  assert.equal(houseAccountId('attn_seeker-1234.atnx.testnet'), 'attn_seeker-1234-h.atnx.testnet');
  assert.equal(houseAccountId('guest-k3j9x2.atnx.testnet'), 'guest-k3j9x2-h.atnx.testnet');
  assert.equal(houseAccountId('u7abc123.atnx.testnet'), 'u7abc123-h.atnx.testnet');
});

test('houseAccountId: another parent', () => {
  assert.equal(houseAccountId('bob.atnx.near', 'atnx.near'), 'bob-h.atnx.near');
  assert.equal(houseAccountId('bob.atnx.testnet', 'atnx.near'), null);
});

test('houseAccountId: input that is not a direct sub-account of the parent', () => {
  assert.equal(houseAccountId('atnx.testnet'), null);
  assert.equal(houseAccountId('alice.testnet'), null);
  assert.equal(houseAccountId('a.b.atnx.testnet'), null);
  assert.equal(houseAccountId('Alice.atnx.testnet'), null);
  assert.equal(houseAccountId('alice-.atnx.testnet'), null);
  assert.equal(houseAccountId('.atnx.testnet'), null);
  assert.equal(houseAccountId(''), null);
  assert.equal(houseAccountId('alice.atnx.testnet', ''), null);
  assert.equal(houseAccountId(undefined as unknown as string), null);
});

test('houseAccountId: the 64-character limit', () => {
  const parent = 'atnx.testnet';
  // A label of 51 fits as a rounds account (51 + 1 + 12 = 64) but not with "-h".
  const longest = 'a'.repeat(64 - parent.length - 1);
  assert.equal(`${longest}.${parent}`.length, 64);
  assert.equal(houseAccountId(`${longest}.${parent}`), null);
  // Two shorter still fits exactly.
  const fits = 'a'.repeat(64 - parent.length - 1 - 2);
  const id = houseAccountId(`${fits}.${parent}`);
  assert.equal(id, `${fits}-h.${parent}`);
  assert.equal(id!.length, 64);
});

test('houseAccountId: a label ending in a dash-h is derived like any other', () => {
  assert.equal(houseAccountId('bob-h.atnx.testnet'), 'bob-h-h.atnx.testnet');
});

test('isReservedHandle: a handle ending in "-h" is reserved for house accounts', () => {
  assert.equal(isReservedHandle('bob-h'), true);
  assert.equal(isReservedHandle('bob-h-h'), true);
  assert.equal(isReservedHandle('Bob-H'), true);
  assert.equal(isReservedHandle(' bob-h '), true);
  assert.equal(isReservedHandle('bob'), false);
  assert.equal(isReservedHandle('bob_h'), false);
  assert.equal(isReservedHandle('bobh'), false);
  assert.equal(isReservedHandle('h'), false);
  assert.equal(isReservedHandle('-hx'), false);
  assert.equal(isReservedHandle(undefined as unknown as string), false);
});

test('isReservedHandle: no generated name ever needs it, a user-chosen one can', () => {
  const rand = (n: number) => new Uint8Array(n).fill(17); // always "h"
  assert.equal(randomHandle(rand), 'uhhhhhhh');
  assert.equal(isReservedHandle(randomHandle(rand)), false);
  // guest-<8 characters>: never "-h" at the end.
  const guest = guestAccountId('atnx.testnet', rand);
  assert.equal(isReservedHandle(guest.slice(0, -'.atnx.testnet'.length)), false);
  // A name with a short random suffix keeps four characters after the dash.
  assert.equal(isReservedHandle('bob-hhhh'), false);
  // An X username can sanitize to one, which the handle chooser must refuse.
  assert.deepEqual(handleCandidates({ username: 'Bob-H' }, 'atnx.testnet'), ['bob-h']);
  assert.equal(isReservedHandle('bob-h'), true);
});

test('houseAccountId with isReservedHandle: no house account is anyone\'s rounds account', async () => {
  // With reserved handles skipped, the derived names never meet the
  // rounds names.
  const taken = new Set<string>();
  const pick = async (handles: string[]) =>
    pickAccountId(
      handles.filter((h) => !isReservedHandle(h)),
      'atnx.testnet',
      async (id) => taken.has(id),
      (n) => new Uint8Array(n).fill(3)
    );
  const bob = await pick(['bob']);
  taken.add(bob);
  const other = await pick(['bob-h']);
  taken.add(other);
  assert.equal(bob, 'bob.atnx.testnet');
  assert.notEqual(other, houseAccountId(bob));
  assert.equal(isReservedHandle(other.slice(0, -'.atnx.testnet'.length)), false);
});
