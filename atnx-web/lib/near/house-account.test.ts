import { test } from 'node:test';
import assert from 'node:assert/strict';
import { houseAccountId } from './house-account';

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
