// The user's NEAR key in this browser: one non-extractable WebCrypto
// Ed25519 key per ATNX user, in IndexedDB. Structured clone stores the
// CryptoKey itself, so the private key never exists as bytes the page could
// read or send anywhere. Clearing the site's data loses it; there is no copy
// anywhere else (by design: a lost key means a fresh account).
import { WebCryptoSigner } from './signer';

const DB = 'atnx-near';
const STORE = 'keys';
const VERSION = 1;

interface KeyRecord {
  userId: string;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  publicKey: string; // "ed25519:..."
  createdAt: string;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'userId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      let value: T;
      req.onsuccess = () => {
        value = req.result;
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB request failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export function keyStoreAvailable(): boolean {
  return hasIndexedDb() && typeof crypto !== 'undefined' && !!crypto.subtle;
}

// The signer for this user in this browser, or null.
export async function loadSigner(userId: string): Promise<WebCryptoSigner | null> {
  if (!hasIndexedDb()) return null;
  const rec = await withStore<KeyRecord | undefined>('readonly', (s) => s.get(userId) as IDBRequest<KeyRecord | undefined>);
  if (!rec?.privateKey || !rec.publicKeyBytes) return null;
  return new WebCryptoSigner(rec.privateKey, new Uint8Array(rec.publicKeyBytes));
}

// A new key for this user, replacing any earlier one in this browser.
export async function createSigner(userId: string): Promise<WebCryptoSigner> {
  const signer = await WebCryptoSigner.generate();
  const rec: KeyRecord = {
    userId,
    privateKey: signer.privateKey,
    publicKeyBytes: Uint8Array.from(signer.publicKey.data),
    publicKey: signer.publicKeyString,
    createdAt: new Date().toISOString(),
  };
  await withStore('readwrite', (s) => s.put(rec));
  return signer;
}

// The stored key, or a new one when there is none.
export async function loadOrCreateSigner(userId: string): Promise<WebCryptoSigner> {
  return (await loadSigner(userId)) ?? createSigner(userId);
}
