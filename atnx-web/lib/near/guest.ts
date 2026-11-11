// Guest accounts on the NEAR build: a gasless account for someone who has
// not signed in, so the market can be tried with no Google or X sign-in.
//
// A guest is NOT a Supabase user. The Supabase project is shared with
// atnx.app, and an anonymous sign-in there would hand every scripted guest
// the `authenticated` role across atnx.app. A guest is only a row in
// bm.near_guests (supabase/bm/005_near_guests.sql), which only the service
// role can read or write, and a key in the guest's browser.
//
// The account is made the way a user's is (lib/near/server-chain.ts): zero
// NEAR, and the browser's key as its only key, a function-call key for the
// rounds contract and the user methods. The relayer relays for it without a
// session when the delegate's sender is an active guest row, with a lower
// hourly cap and without `withdraw` (lib/near/routes.ts).
//
// What a guest costs the parent and the relayer is bounded in the database:
// at most GUEST_CAPS.perIp guests per client IP per hour and GUEST_CAPS.perDay
// overall in any 24 hours (bm.near_guest_reserve), and no new guest while
// the relayer or the parent is below its floor.
import { randomSuffix, isValidAccountId } from './handle';
import type { GuestReserveCaps, RelayLockOptions } from './store';

export const GUEST_LABEL = 'guest';
export const GUEST_SUFFIX_CHARS = 8;

// guest-<8 lowercase letters or digits>.<parent>
export function guestAccountId(parent: string, rand?: (n: number) => Uint8Array): string {
  return `${GUEST_LABEL}-${randomSuffix(GUEST_SUFFIX_CHARS, rand)}.${parent}`;
}

export function isGuestAccountId(id: string, parent: string): boolean {
  if (typeof id !== 'string' || !isValidAccountId(id) || !id.endsWith(`.${parent}`)) return false;
  return new RegExp(`^${GUEST_LABEL}-[0-9a-z]{${GUEST_SUFFIX_CHARS}}$`).test(id.slice(0, -parent.length - 1));
}

// Guests per client IP (its bucket, see ipBucket) per ipWindowSecs, and
// guests overall per dayWindowSecs (both rolling windows).
export type GuestCaps = GuestReserveCaps;

export const GUEST_CAPS: GuestCaps = { perIp: 10, ipWindowSecs: 3_600, perDay: 300, dayWindowSecs: 86_400 };

// A guest's relays: one in flight, at most 60 an hour (a signed-in user
// gets 200).
export const GUEST_LOCK: RelayLockOptions = { ttlSecs: 60, windowSecs: 3_600, maxPerWindow: 60 };

// What a guest may call through the relayer: the faucet, commit, buy, claim
// and roll. Not `withdraw`, which would move test USDG out to the token and
// make usdg.atnx.testnet pay for registering every guest there. The key on
// chain still has the user methods (it is made by the same code), but a
// zero-NEAR account can only act through the relayer.
export const GUEST_METHODS = ['faucet', 'commit', 'buy', 'claim', 'claim_rollover'] as const;

// ------------------------------------------------------------- the IP

export interface HeaderReader {
  get(name: string): string | null;
}

// The client's IP as Vercel passes it on: the first entry of
// x-forwarded-for (Vercel overwrites the header with the client's address),
// else x-real-ip. Null when neither holds an address, e.g. a local run.
export function clientIp(headers: HeaderReader): string | null {
  const forwarded = headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  for (const candidate of [first, headers.get('x-real-ip')?.trim()]) {
    if (!candidate) continue;
    const ip = stripPort(candidate);
    if (parseIpv4(ip) || parseIpv6(ip)) return ip;
  }
  return null;
}

function stripPort(s: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) return bracketed[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  return v4port ? v4port[1] : s;
}

function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

// Eight 16-bit groups, or null.
function parseIpv6(raw: string): number[] | null {
  let s = raw.toLowerCase().replace(/%.*$/, ''); // a zone id ("%eth0") is not part of the address
  if (!s.includes(':')) return null;
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = parseIpv4(tail[2]);
    if (!v4) return null;
    s = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const read = (h: string) => (h === '' ? [] : h.split(':'));
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

// What the per-IP cap counts: an IPv4 address as it is; an IPv6 address by
// its /64, which one subscriber usually holds whole, so a guest farm cannot
// step through the addresses of one network; an IPv4-mapped IPv6 address as
// the IPv4 one. Anything unreadable, and no address at all, share one
// bucket, "unknown".
export function ipBucket(ip: string | null): string {
  if (!ip) return 'unknown';
  const v4 = parseIpv4(ip);
  if (v4) return `v4:${v4.join('.')}`;
  const v6 = parseIpv6(ip);
  if (!v6) return 'unknown';
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
    return `v4:${[v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff].join('.')}`;
  }
  return `v6:${v6
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

// The salted sha256 of the client's IP bucket, as bm.near_guests stores it:
// HMAC-SHA256 keyed by a server-only salt, so the hash cannot be reversed by
// trying every IPv4 address. The raw IP is never stored or logged.
export async function hashIp(salt: string, ip: string | null): Promise<string> {
  if (!salt) throw new Error('hashIp: no salt');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`atnx-near-guest-ip/v1:${ipBucket(ip)}`)));
}
