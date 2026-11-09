// The browser's NEAR key store in IndexedDB: database "atnx-near", store
// "keys", one record per ATNX user id, plus one for the guest account under
// the id "guest" (a user id is a uuid, so they cannot meet). No near-api-js
// here, so the header can read the guest's account id without loading it
// (lib/near/guest-local.ts); the keys themselves are lib/near/keystore.ts.

const DB = 'atnx-near';
const STORE = 'keys';
const VERSION = 1;

export const GUEST_RECORD_ID = 'guest';

export interface KeyRecord {
  userId: string;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  publicKey: string; // "ed25519:..."
  createdAt: string;
  // The guest record only: its account once /api/near/guest made it.
  accountId?: string;
}

export function hasIndexedDb(): boolean {
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

export async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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

export function getRecord(id: string): Promise<KeyRecord | undefined> {
  return withStore<KeyRecord | undefined>('readonly', (s) => s.get(id) as IDBRequest<KeyRecord | undefined>);
}

export async function putRecord(rec: KeyRecord): Promise<void> {
  await withStore('readwrite', (s) => s.put(rec));
}
