"use client";

import type { HousePosition } from "@/lib/bm/house-types";
import type { Tracked } from "@/lib/bm/house-ticket";

// The orders and closes this tab sent, and the waiting positions it saw,
// kept in sessionStorage so that after a reload the ticket and the
// portfolio still say what became of them ("Filled at …", "Not filled: …",
// "Closed. …"). sessionStorage is per tab and goes with it; when it can't
// be used (a private window, storage off), everything still works for the
// life of the page.
//
// Tracks are kept per account, at most MAX_TRACKS, for TRACK_TTL_MS after
// they were sent (an order may wait 15 minutes before it can be
// cancelled), and for DONE_TTL_MS once they have resolved.

export interface StoredTrack extends Tracked {
  // The market the order or close is on, so a market's ticket shows only
  // its own.
  market?: number;
  // When the line first showed the outcome.
  doneAtMs?: number;
  // The transaction that sent the order or the close, for the line's
  // "View transaction" link.
  txHash?: string;
}

const TRACKS = "atnx.house.tracks.";
const SEEN = "atnx.house.seen";
const MAX_TRACKS = 6;
export const TRACK_TTL_MS = 20 * 60_000;
export const DONE_TTL_MS = 2 * 60_000;
const MAX_SEEN = 40;

// JSON with bigints (as {"$n": "…"}).
function stringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $n: x.toString() } : x));
}
function parse<T>(s: string): T {
  return JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.$n === "string" && Object.keys(x).length === 1 ? BigInt(x.$n) : x)) as T;
}

function read<T>(key: string): T | null {
  try {
    const s = globalThis.sessionStorage?.getItem(key);
    return s ? parse<T>(s) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown) {
  try {
    globalThis.sessionStorage?.setItem(key, stringify(v));
  } catch {
    // Storage full or off: the page keeps what it has in memory.
  }
}

// ------------------------------------------------------------ the tracks

const EMPTY: StoredTrack[] = [];
const cache = new Map<string, StoredTrack[]>();
const listeners = new Set<() => void>();

function prune(ts: StoredTrack[], now: number): StoredTrack[] {
  return ts.filter((t) => now - t.sentAtMs < TRACK_TTL_MS && (t.doneAtMs === undefined || now - t.doneAtMs < DONE_TTL_MS)).slice(-MAX_TRACKS);
}

export function tracksOf(accountId: string | null): StoredTrack[] {
  if (!accountId) return EMPTY;
  let ts = cache.get(accountId);
  if (!ts) {
    const stored = read<StoredTrack[]>(TRACKS + accountId);
    ts = prune(Array.isArray(stored) ? stored.filter((t) => typeof t?.id === "bigint") : [], Date.now());
    cache.set(accountId, ts);
  }
  return ts;
}

function set(accountId: string, ts: StoredTrack[]) {
  cache.set(accountId, ts);
  write(TRACKS + accountId, ts);
  for (const l of listeners) l();
}

export function subscribeTracks(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emptyTracks(): StoredTrack[] {
  return EMPTY;
}

export function addTrack(accountId: string, t: StoredTrack) {
  set(accountId, prune([...tracksOf(accountId).filter((x) => x.id !== t.id), t], Date.now()));
}

export function dropTrack(accountId: string, id: bigint) {
  set(
    accountId,
    tracksOf(accountId).filter((t) => t.id !== id),
  );
}

// The outcome is on screen: the track goes once DONE_TTL_MS has passed.
export function settleTrack(accountId: string, id: bigint) {
  const ts = tracksOf(accountId);
  if (!ts.some((t) => t.id === id && t.doneAtMs === undefined)) return;
  set(
    accountId,
    ts.map((t) => (t.id === id ? { ...t, doneAtMs: Date.now() } : t)),
  );
}

// ------------------------------------------------- positions seen waiting

interface Seen {
  positions: Record<string, HousePosition>;
  closing: string[];
}

let seenStore: Seen | null = null;

function seen(): Seen {
  if (!seenStore) {
    const s = read<Seen>(SEEN);
    seenStore = s && typeof s === "object" && s.positions && Array.isArray(s.closing) ? s : { positions: {}, closing: [] };
  }
  return seenStore;
}

// Keeps the waiting positions of a read (an order not filled yet, a close
// in flight): what they looked like, to say why one was refunded once it is
// gone, and whether a close was seen in flight.
export function rememberWaiting(ps: readonly HousePosition[]) {
  const s = seen();
  let changed = false;
  for (const p of ps) {
    if (p.state !== "Pending" && p.state !== "Closing") continue;
    const key = p.id.toString();
    s.positions[key] = p;
    changed = true;
    if (p.state === "Closing" && !s.closing.includes(key)) s.closing.push(key);
  }
  if (!changed) return;
  const keys = Object.keys(s.positions);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SEEN))) delete s.positions[k];
  s.closing = s.closing.slice(-MAX_SEEN);
  write(SEEN, s);
}

export function storedPosition(id: bigint): HousePosition | null {
  return seen().positions[id.toString()] ?? null;
}

export function storedAsClosing(id: bigint): boolean {
  return seen().closing.includes(id.toString());
}
