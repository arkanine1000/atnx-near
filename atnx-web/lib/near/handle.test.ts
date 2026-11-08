import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCandidates, isSubAccountOf, isValidAccountId, maxHandleLength, pickAccountId, randomHandle, sanitizeHandle } from './handle';

test('names are cleaned into NEAR handles', () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ['alice', 'alice'],
    ['Alice', 'alice'],
    ['Attn_seeker#1234', 'attn_seeker-1234'],
    ['Zoë Smith', 'zoe-smith'],
    ['  bob  ', 'bob'],
    ['__bob__', 'bob'],
    ['a.b', 'a-b'],
    ['a--b__c-_d', 'a-b_c-d'],
    ['élan.vital', 'elan-vital'],
    ['日本語', null],
    ['🚀🚀', null],
    ['x', null],
    ['-', null],
    ['', null],
    [null, null],
    [undefined, null],
    ['Relayer', null], // reserved
    ['keeper', null],
    ['rounds', null],
    ['ROUNDS2', 'rounds2'],
  ];
  for (const [raw, want] of cases) assert.equal(sanitizeHandle(raw), want, `sanitizeHandle(${JSON.stringify(raw)})`);
});

test('handles are capped without leaving a trailing separator', () => {
  assert.equal(sanitizeHandle('a'.repeat(40)), 'a'.repeat(32));
  assert.equal(sanitizeHandle(`${'a'.repeat(31)}-bbbb`), 'a'.repeat(31));
  assert.equal(sanitizeHandle('abcdef', 4), 'abcd');
});

test('every sanitised handle makes a valid sub-account', () => {
  const parent = 'atnx.testnet';
  const samples = ['Attn_seeker#9999', 'Zoë Smith', 'a.b.c', '___x__y___', 'MiXeD-Case_99', 'a'.repeat(200), 'émoji 🚀 name', '0x1234abcd'];
  for (const s of samples) {
    const h = sanitizeHandle(s, maxHandleLength(parent));
    if (!h) continue;
    const id = `${h}.${parent}`;
    assert.ok(isValidAccountId(id), id);
    assert.ok(isSubAccountOf(id, parent), id);
  }
});

test('account id rules', () => {
  assert.ok(isValidAccountId('alice.atnx.testnet'));
  assert.ok(isValidAccountId('a_b-c.atnx.testnet'));
  assert.ok(!isValidAccountId('a--b.atnx.testnet'));
  assert.ok(!isValidAccountId('-a.atnx.testnet'));
  assert.ok(!isValidAccountId('Alice.atnx.testnet'));
  assert.ok(!isValidAccountId(`${'a'.repeat(52)}.atnx.testnet`)); // 65 characters
  assert.ok(isValidAccountId(`${'a'.repeat(51)}.atnx.testnet`)); // 64
  assert.ok(isSubAccountOf('alice.atnx.testnet', 'atnx.testnet'));
  assert.ok(!isSubAccountOf('x.alice.atnx.testnet', 'atnx.testnet'));
  assert.ok(!isSubAccountOf('atnx.testnet', 'atnx.testnet'));
  assert.ok(!isSubAccountOf('alice.testnet', 'atnx.testnet'));
});

test('candidates: the X username first, then the profile handle, no duplicates', () => {
  assert.deepEqual(handleCandidates({ username: 'Alice_X', handle: 'Attn_seeker#1234' }, 'atnx.testnet'), ['alice_x', 'attn_seeker-1234']);
  assert.deepEqual(handleCandidates({ username: 'bob', handle: 'BOB' }, 'atnx.testnet'), ['bob']);
  assert.deepEqual(handleCandidates({ username: '🚀', handle: null }, 'atnx.testnet'), []);
});

test('random handles are short and valid', () => {
  for (let i = 0; i < 50; i++) {
    const h = randomHandle();
    assert.match(h, /^u[0-9a-z]{7}$/);
    assert.ok(isValidAccountId(`${h}.atnx.testnet`));
  }
});

test('pickAccountId: the name, then a suffix, then a random handle', async () => {
  const taken = new Set(['alice.atnx.testnet']);
  const id = await pickAccountId(['alice'], 'atnx.testnet', async (x) => taken.has(x));
  assert.match(id, /^alice-[0-9a-z]{4}\.atnx\.testnet$/);
  assert.equal(await pickAccountId(['bob'], 'atnx.testnet', async () => false), 'bob.atnx.testnet');
  const all = await pickAccountId(['alice'], 'atnx.testnet', async (x) => x.startsWith('alice'));
  assert.match(all, /^u[0-9a-z]{7}\.atnx\.testnet$/);
  assert.match(await pickAccountId([], 'atnx.testnet', async () => false), /^u[0-9a-z]{7}\.atnx\.testnet$/);
  await assert.rejects(pickAccountId(['alice'], 'atnx.testnet', async () => true));
});
