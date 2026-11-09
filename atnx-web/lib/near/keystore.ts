// The user's NEAR key in this browser: one non-extractable WebCrypto
// Ed25519 key per ATNX user, in IndexedDB (lib/near/idb.ts). Structured
// clone stores the CryptoKey itself, so the private key never exists as
// bytes the page could read or send anywhere. Clearing the site's data loses
// it; there is no copy anywhere else (by design: a lost key means a fresh
// account).
//
// A guest (no sign-in, /api/near/guest) has one record of its own under the
// id "guest", holding its key and, once made, its account id.
import { GUEST_RECORD_ID, getRecord, hasIndexedDb, putRecord, type KeyRecord } from './idb';
import { WebCryptoSigner } from './signer';

export function keyStoreAvailable(): boolean {
  return hasIndexedDb() && typeof crypto !== 'undefined' && !!crypto.subtle;
}

function signerOf(rec: KeyRecord | undefined): WebCryptoSigner | null {
  if (!rec?.privateKey || !rec.publicKeyBytes) return null;
  return new WebCryptoSigner(rec.privateKey, new Uint8Array(rec.publicKeyBytes));
}

async function newRecord(id: string): Promise<{ signer: WebCryptoSigner; rec: KeyRecord }> {
  const signer = await WebCryptoSigner.generate();
  const rec: KeyRecord = {
    userId: id,
    privateKey: signer.privateKey,
    publicKeyBytes: Uint8Array.from(signer.publicKey.data),
    publicKey: signer.publicKeyString,
    createdAt: new Date().toISOString(),
  };
  await putRecord(rec);
  return { signer, rec };
}

// The signer for this user in this browser, or null.
export async function loadSigner(userId: string): Promise<WebCryptoSigner | null> {
  if (!hasIndexedDb()) return null;
  return signerOf(await getRecord(userId));
}

// A new key for this user, replacing any earlier one in this browser.
export async function createSigner(userId: string): Promise<WebCryptoSigner> {
  return (await newRecord(userId)).signer;
}

// The stored key, or a new one when there is none.
export async function loadOrCreateSigner(userId: string): Promise<WebCryptoSigner> {
  return (await loadSigner(userId)) ?? createSigner(userId);
}

// ---------------------------------------------------------------- guest

export interface LocalGuest {
  signer: WebCryptoSigner;
  publicKey: string;
  // Null until /api/near/guest made the account.
  accountId: string | null;
}

export async function loadGuest(): Promise<LocalGuest | null> {
  if (!hasIndexedDb()) return null;
  const rec = await getRecord(GUEST_RECORD_ID);
  const signer = signerOf(rec);
  return signer && rec ? { signer, publicKey: rec.publicKey, accountId: rec.accountId ?? null } : null;
}

// A new guest key with no account yet, replacing any earlier guest record.
export async function createGuestKey(): Promise<LocalGuest> {
  const { signer, rec } = await newRecord(GUEST_RECORD_ID);
  return { signer, publicKey: rec.publicKey, accountId: null };
}

// Records the account /api/near/guest made for the stored guest key.
export async function saveGuestAccount(publicKey: string, accountId: string): Promise<void> {
  const rec = await getRecord(GUEST_RECORD_ID);
  if (!rec || rec.publicKey !== publicKey) throw new Error('the guest key in this browser changed');
  await putRecord({ ...rec, accountId });
}
