import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestAccountId } from './guest';
import { handleCandidates, isReservedHandle, pickAccountId, randomHandle, sanitizeHandle } from './handle';
import { houseAccountId, houseKeyVerdict, roundsAccountOf } from './house-account';

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

test('isReservedHandle: the platform names and the guest names stay reserved', () => {
  for (const h of ['admin', 'rounds', 'treasury', 'guest', 'guest-abc', 'guest_x', 'Keeper']) assert.equal(isReservedHandle(h), true, h);
  for (const h of ['alice', 'guests', 'myguest', 'attn_seeker-1234']) assert.equal(isReservedHandle(h), false, h);
});

test('isReservedHandle: no generated name ever needs it, a user-chosen one can', () => {
  const rand = (n: number) => new Uint8Array(n).fill(17); // always "h"
  assert.equal(randomHandle(rand), 'uhhhhhhh');
  assert.equal(isReservedHandle(randomHandle(rand)), false);
  // guest-<8 characters>: never "-h" at the end (and "guest-" itself is
  // reserved, so no user handle looks like one).
  const guest = guestAccountId('atnx.testnet', rand);
  assert.equal(guest.slice(0, -'.atnx.testnet'.length).endsWith('-h'), false);
  // A name with a short random suffix keeps four characters after the dash.
  assert.equal(isReservedHandle('bob-hhhh'), false);
  // An X username that sanitizes to one is refused like any reserved name,
  // so the chooser falls back to the next candidate.
  assert.equal(sanitizeHandle('Bob-H'), null);
  assert.equal(sanitizeHandle('bob.h'), null);
  assert.deepEqual(handleCandidates({ username: 'Bob-H' }, 'atnx.testnet'), []);
  assert.deepEqual(handleCandidates({ username: 'Bob-H', handle: 'bobby' }, 'atnx.testnet'), ['bobby']);
});

test('pickAccountId: never tries a reserved handle, even when handed one', async () => {
  const tried: string[] = [];
  const id = await pickAccountId(['bob-h', 'admin'], 'atnx.testnet', async (id) => {
    tried.push(id);
    return false;
  }, (n) => new Uint8Array(n).fill(3));
  assert.ok(!tried.includes('bob-h.atnx.testnet'));
  assert.ok(!tried.includes('admin.atnx.testnet'));
  // The suffixed forms are not reserved: bob-h-3333 is the first try.
  assert.equal(id, 'bob-h-3333.atnx.testnet');
  assert.equal(houseAccountId(id), 'bob-h-3333-h.atnx.testnet');
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

test('roundsAccountOf: the inverse of houseAccountId', () => {
  for (const r of ['alice.atnx.testnet', 'guest-k3j9x2ab.atnx.testnet', 'u7abc123.atnx.testnet', 'bob-h.atnx.testnet']) {
    assert.equal(roundsAccountOf(houseAccountId(r)!), r);
  }
  assert.equal(roundsAccountOf('alice.atnx.testnet'), null);
  assert.equal(roundsAccountOf('-h.atnx.testnet'), null);
  assert.equal(roundsAccountOf('alice-h.atnx.near'), null);
  assert.equal(roundsAccountOf('alice-h.atnx.near', 'atnx.near'), 'alice.atnx.near');
  assert.equal(roundsAccountOf('a.alice-h.atnx.testnet'), null);
  assert.equal(roundsAccountOf('alice_h.atnx.testnet'), null);
  assert.equal(roundsAccountOf(undefined as unknown as string), null);
});

test('houseKeyVerdict: reuse only an account holding exactly the browser key for the house contract', () => {
  const PK = 'ed25519:4ZXT1Lj1s8dGg9ZXYjbGkyXzGwHzm5CLQZLLyfDe3Zoz';
  const OTHER = 'ed25519:9pJ5UVZ5KnFZt8qkXbbVt7uyAhcTAMPV3iRFVLwPm1a1';
  const HOUSE = 'house.atnx.testnet';
  const fc = (receiverId: string, methodNames: string[] = []) => ({ receiverId, methodNames });
  assert.equal(houseKeyVerdict([{ publicKey: PK, permission: fc(HOUSE) }], PK, HOUSE), 'match');
  // Another key, a second key, a full-access key, another receiver, a method list.
  assert.equal(houseKeyVerdict([{ publicKey: OTHER, permission: fc(HOUSE) }], PK, HOUSE), 'clash');
  assert.equal(houseKeyVerdict([{ publicKey: PK, permission: fc(HOUSE) }, { publicKey: OTHER, permission: fc(HOUSE) }], PK, HOUSE), 'clash');
  assert.equal(houseKeyVerdict([{ publicKey: PK, permission: 'FullAccess' }], PK, HOUSE), 'clash');
  assert.equal(houseKeyVerdict([{ publicKey: PK, permission: fc('rounds.atnx.testnet') }], PK, HOUSE), 'clash');
  assert.equal(houseKeyVerdict([{ publicKey: PK, permission: fc(HOUSE, ['open']) }], PK, HOUSE), 'clash');
  assert.equal(houseKeyVerdict([], PK, HOUSE), 'clash');
});
