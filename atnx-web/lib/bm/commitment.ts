import { createHash } from 'node:crypto';
import { averageVi, toE2 } from './settle';

// The oracle commitment a NEAR settle carries: the sha256 of a canonical
// JSON of everything the keeper used to settle the round. The keeper
// stores the same JSON in bm.rounds.settle_inputs, so anyone can recompute
// the hash and compare it with the round's `commitment` on chain
// (`npm run rounds:verify`), then recompute the average from the prints.
// Solana settles keep the zero commitment.
//
// The inputs, version 1:
//
//   { "average_e2": 41235,                 the posted settle_e2
//     "market_id": "<uuid, lowercase>",
//     "prints": [{ "at": "<ts>", "vi": 412.3 }, ...],
//     "round_index": 3,
//     "series_reference": "<64 hex>",
//     "version": 1,
//     "window_end": "<ts>",                 the round's close_at
//     "window_start": "<ts>" }              close_at − settlement window
//
// Timestamps are UTC with six fractional digits and a Z, as Postgres
// records them (2026-11-08T16:20:59.250210Z). The prints are the
// vi_history rows recorded in [window_start, window_end], sorted by `at`,
// then by `vi`. average_e2 is round(100 · mean), where the mean is the
// double-precision sum of the prints in that order, divided by their count
// and rounded to two decimals (lib/bm/settle.ts, averageVi then toE2).
//
// Canonical JSON: object keys sorted by UTF-16 code units, no whitespace,
// strings and numbers as JSON.stringify writes them (the shortest form
// that round-trips a double, which is also RFC 8785's number form). The
// hash is sha256 over its UTF-8 bytes, as 64 lowercase hex characters,
// exactly what the contract's `commitment` argument accepts.

export const SETTLE_INPUTS_VERSION = 1;
export const ZERO_COMMITMENT = '0'.repeat(64);

export interface SettlePrint {
  at: string;
  vi: number;
}

export interface SettleInputs {
  version: typeof SETTLE_INPUTS_VERSION;
  market_id: string;
  series_reference: string;
  round_index: number;
  window_start: string;
  window_end: string;
  prints: SettlePrint[];
  average_e2: number;
}

// ------------------------------------------------------- canonical JSON

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: ${value} is not a finite number`);
      // JSON.stringify(-0) is "0", as RFC 8785 wants.
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`canonicalJson: only plain objects, got ${proto?.constructor?.name ?? 'an object'}`);
      }
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [k, v] of entries) {
        if (v === undefined) throw new Error(`canonicalJson: ${k} is undefined`);
      }
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: cannot encode a ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ----------------------------------------------------------- timestamps

const TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

// A timestamp as UTC with exactly six fractional digits and a Z. Takes a
// Date (millisecond precision) or a string as PostgREST or Postgres print
// timestamptz ("2026-11-08T16:20:59.25021+00:00", "... 16:20:59+00",
// "...Z"); a string without a zone is read as UTC. Digits past the sixth
// are cut, as Postgres stores microseconds.
export function canonicalTimestamp(input: string | Date): string {
  if (input instanceof Date) {
    const ms = input.getTime();
    if (!Number.isFinite(ms)) throw new Error('canonicalTimestamp: invalid date');
    const secs = Math.floor(ms / 1000);
    const micros = (ms - secs * 1000) * 1000;
    return `${new Date(secs * 1000).toISOString().slice(0, 19)}.${String(micros).padStart(6, '0')}Z`;
  }
  const m = TS.exec(input.trim());
  if (!m) throw new Error(`canonicalTimestamp: cannot read ${JSON.stringify(input)}`);
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m;
  let offsetMin = 0;
  if (zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!;
    offsetMin = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3] ?? 0));
  }
  const utcSecs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000 - offsetMin * 60;
  if (!Number.isFinite(utcSecs)) throw new Error(`canonicalTimestamp: cannot read ${JSON.stringify(input)}`);
  const iso = new Date(utcSecs * 1000).toISOString();
  return `${iso.slice(0, 19)}.${frac.slice(0, 6).padEnd(6, '0')}Z`;
}

// ---------------------------------------------------------------- inputs

export interface SettleRow {
  vi: number | string;
  recorded_at: string;
}

export function sortPrints(prints: SettlePrint[]): SettlePrint[] {
  return [...prints].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.vi - b.vi));
}

// The settle inputs of one round, from the vi_history rows recorded in its
// window (in any order). Null when there is no print: such a round is
// voided, not settled.
export function buildSettleInputs(args: {
  marketId: string;
  reference: string;
  roundIndex: number;
  // The round's close_at on chain, unix seconds.
  closeAt: number;
  windowSecs: number;
  rows: SettleRow[];
}): SettleInputs | null {
  if (args.rows.length === 0) return null;
  const reference = args.reference.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(reference)) throw new Error('buildSettleInputs: reference must be 64 hex characters');
  if (!/^[0-9a-f-]{36}$/i.test(args.marketId)) throw new Error('buildSettleInputs: market id is not a uuid');
  if (!Number.isSafeInteger(args.roundIndex) || args.roundIndex < 1) throw new Error('buildSettleInputs: bad round index');
  const prints = sortPrints(
    args.rows.map((r) => {
      const vi = Number(r.vi);
      if (!Number.isFinite(vi)) throw new Error(`buildSettleInputs: bad VI ${String(r.vi)}`);
      return { at: canonicalTimestamp(r.recorded_at), vi };
    })
  );
  return {
    version: SETTLE_INPUTS_VERSION,
    market_id: args.marketId.toLowerCase(),
    series_reference: reference,
    round_index: args.roundIndex,
    window_start: canonicalTimestamp(new Date((args.closeAt - args.windowSecs) * 1000)),
    window_end: canonicalTimestamp(new Date(args.closeAt * 1000)),
    prints,
    average_e2: averageE2(prints),
  };
}

// round(100 · mean) over the prints in the order given (sorted, for
// inputs): what the keeper posts as settle_e2.
export function averageE2(prints: Array<{ vi: number }>): number {
  const avg = averageVi(prints);
  if (avg === null) throw new Error('averageE2: no prints');
  return Number(toE2(avg));
}

export function settleCommitment(inputs: SettleInputs): { json: string; hash: string } {
  const json = canonicalJson(inputs);
  return { json, hash: sha256Hex(json) };
}

// ----------------------------------------------------------------- verify

export interface VerifyResult {
  ok: boolean;
  hash: string;
  problems: string[];
}

// Checks stored settle inputs (as read back from bm.rounds.settle_inputs:
// jsonb reorders keys, which the canonical form undoes) against what the
// chain holds for the round. `expect` names what the registry says the
// inputs belong to.
export function verifySettleInputs(
  stored: unknown,
  chain: { commitment: string; settleE2: bigint; closeAt: number },
  expect: { marketId?: string; reference?: string; roundIndex?: number; windowSecs?: number } = {}
): VerifyResult {
  const problems: string[] = [];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return { ok: false, hash: '', problems: ['no settle inputs stored'] };
  }
  const s = stored as Partial<SettleInputs>;
  const json = canonicalJson(stored);
  const hash = sha256Hex(json);
  if (hash !== chain.commitment) problems.push(`hash ${hash} is not the on-chain commitment ${chain.commitment}`);
  if (s.version !== SETTLE_INPUTS_VERSION) problems.push(`unknown inputs version ${String(s.version)}`);
  const prints = Array.isArray(s.prints) ? s.prints : [];
  if (prints.length === 0) problems.push('no prints in the inputs');
  else {
    const sorted = sortPrints(prints);
    if (canonicalJson(sorted) !== canonicalJson(prints)) problems.push('prints are not in canonical order');
    for (const p of prints) {
      if (typeof p?.at !== 'string' || canonicalTimestamp(p.at) !== p.at) problems.push(`print time ${String(p?.at)} is not canonical`);
      if (typeof p?.vi !== 'number' || !Number.isFinite(p.vi)) problems.push(`print VI ${String(p?.vi)} is not a number`);
    }
    if (prints.every((p) => typeof p?.vi === 'number' && Number.isFinite(p.vi))) {
      const avg = averageE2(prints);
      if (avg !== s.average_e2) problems.push(`average of the prints is ${avg} (e2), the inputs say ${String(s.average_e2)}`);
    }
    if (typeof s.window_start === 'string' && typeof s.window_end === 'string') {
      const outside = prints.filter((p) => typeof p?.at === 'string' && (p.at < s.window_start! || p.at > s.window_end!));
      if (outside.length) problems.push(`${outside.length} print(s) outside [window_start, window_end]`);
    }
  }
  const avgE2 = typeof s.average_e2 === 'number' && Number.isSafeInteger(s.average_e2) ? BigInt(s.average_e2) : null;
  if (avgE2 === null || avgE2 !== chain.settleE2) problems.push(`inputs average ${String(s.average_e2)} is not the on-chain settle_e2 ${chain.settleE2}`);
  if (s.window_end !== canonicalTimestamp(new Date(chain.closeAt * 1000))) problems.push(`window_end ${String(s.window_end)} is not the round's close`);
  if (expect.windowSecs !== undefined && s.window_start !== canonicalTimestamp(new Date((chain.closeAt - expect.windowSecs) * 1000))) {
    problems.push(`window_start ${String(s.window_start)} is not close − ${expect.windowSecs} s`);
  }
  if (expect.marketId !== undefined && s.market_id !== expect.marketId.toLowerCase()) problems.push(`market ${String(s.market_id)} is not ${expect.marketId}`);
  if (expect.reference !== undefined && s.series_reference !== expect.reference.toLowerCase()) problems.push('series reference differs from the registry');
  if (expect.roundIndex !== undefined && s.round_index !== expect.roundIndex) problems.push(`round ${String(s.round_index)} is not ${expect.roundIndex}`);
  return { ok: problems.length === 0, hash, problems };
}
