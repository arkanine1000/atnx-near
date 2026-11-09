"use client";

// The guest account this browser holds, for the header: its account id from
// IndexedDB (lib/near/idb.ts), and a change signal when one is made. Light on
// purpose: no near-api-js, so the header can show the guest state on every
// page without loading the signer.
import { useEffect, useState } from 'react';
import { GUEST_RECORD_ID, getRecord, hasIndexedDb } from './idb';

const EVENT = 'atnx:near-guest';

export async function readGuestAccountId(): Promise<string | null> {
  if (!hasIndexedDb()) return null;
  try {
    return (await getRecord(GUEST_RECORD_ID))?.accountId ?? null;
  } catch {
    return null;
  }
}

// Tells this tab, and other tabs on the site, that the guest changed.
export function notifyGuestChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(EVENT));
  try {
    const ch = new BroadcastChannel(EVENT);
    ch.postMessage('changed');
    ch.close();
  } catch {
    /* no BroadcastChannel */
  }
}

export function onGuestChanged(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT, cb);
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(EVENT);
    ch.onmessage = cb;
  } catch {
    ch = null;
  }
  return () => {
    window.removeEventListener(EVENT, cb);
    ch?.close();
  };
}

// The guest account id in this browser, or null; undefined while reading.
export function useGuestAccountId(enabled = true): string | null | undefined {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = () => void readGuestAccountId().then((v) => alive && setId(v));
    read();
    const off = onGuestChanged(read);
    return () => {
      alive = false;
      off();
    };
  }, [enabled]);
  return enabled ? id : null;
}
