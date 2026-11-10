"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { JsonRpcProvider } from "near-api-js";
import { useAuth } from "@/context/AuthContext";
import { NearActError, createActor, type ActResult, type NearMethod } from "@/lib/near/client";
import { HOUSE_METHOD_GAS, NEAR_HOUSE, NEAR_PARENT, isHouseProduct, isNearHouseDeployed, isNearRoundsDeployed } from "@/lib/near/config";
import { nearRpcProvider } from "@/lib/near/rpc";
import { hasHouseKey } from "@/lib/near/house";
import { houseAccountId } from "@/lib/near/house-account";
import { notifyGuestChanged, onGuestChanged } from "@/lib/near/guest-local";
import { createGuestKey, createSigner, keyStoreAvailable, loadGuest, loadOrCreateSigner, loadSigner, saveGuestAccount } from "@/lib/near/keystore";
import { webCryptoEd25519Supported, type WebCryptoSigner } from "@/lib/near/signer";

// The signed-in user's gasless NEAR account, as the ticket, the portfolio
// and Settings see it:
//
//   unconfigured   NEAR is not set up on this deployment
//   signed-out     no ATNX session
//   loading        reading the session, the account and this browser's key
//   none           signed in, no account yet: ensureAccount() makes one
//   creating       the account is being set up (in this tab or another)
//   ready          the account exists and this browser holds its key
//   other-browser  the account's key lives in another browser (or was
//                  lost): startFresh() makes a new account for this one
//   unsupported    this browser cannot keep a WebCrypto Ed25519 key
//   error          the account could not be read or set up
//
// ensureAccount() makes a non-extractable key in IndexedDB and asks
// /api/near/account for <handle>.atnx.testnet with that key. act(method,
// args) signs one call and relays it (lib/near/client.ts), one at a time.
//
// Signed out, the hook speaks for the guest account this browser holds, if
// any: startGuest() makes a key under "guest" in IndexedDB and asks
// /api/near/guest, with no session, for guest-<8>.atnx.testnet. The guest
// is then "ready" with isGuest set, and act() relays through the relay's
// guest branch. A guest who signs in gets their own user account as before;
// the guest account stays in this browser, separate (guestAccountId), and
// is the one used again after signing out. Nothing merges them.
//
// With the house on (NEXT_PUBLIC_BM_NEAR_PRODUCT=house) the hook speaks for
// the house account instead: the rounds account is still made and kept as
// before, and the route also makes its derived house account
// (houseAccountId) with the same browser key. accountId and guestAccountId
// are the house accounts, act() signs for the house account on the house
// contract, and "ready" also needs the house account to hold this
// browser's key on chain; until it does the status is "none", and setting
// up (ensureAccount, or startGuest for a guest) asks the route again, which
// makes it.

export type NearAccountStatus = "unconfigured" | "signed-out" | "loading" | "none" | "creating" | "ready" | "other-browser" | "unsupported" | "error";

interface ServerAccount {
  accountId: string;
  publicKey: string;
  state: "creating" | "active";
  previousAccountIds: string[];
}

interface AccountSnapshot {
  server: ServerAccount | null;
  localKey: string | null;
  supported: boolean;
  // House on: whether the house account holds this browser's key (null
  // when there is nothing to look at yet).
  houseReady?: boolean | null;
}

const HOUSE = isHouseProduct();

let rpc: JsonRpcProvider | null = null;
function provider(): JsonRpcProvider {
  if (!rpc) rpc = nearRpcProvider();
  return rpc;
}

// The account the page trades with and links to: the house account of a
// rounds account when the house is on, the rounds account otherwise.
function asHouse(id: string | null): string | null {
  return HOUSE && id ? houseAccountId(id, NEAR_PARENT) : id;
}

// Whether the house account of `roundsAccountId` holds `publicKey` as a key
// for the house contract. A failed read counts as no: setting up again is
// harmless (the route reuses an account that already has the key).
async function houseReadyFor(roundsAccountId: string, publicKey: string): Promise<boolean> {
  const id = houseAccountId(roundsAccountId, NEAR_PARENT);
  if (!id) return false;
  return hasHouseKey(provider(), id, publicKey, NEAR_HOUSE).catch(() => false);
}

export class NearAccountError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "NearAccountError";
  }
}

// --------------------------------------------- shared across hook users

// Signers by user id, so every component signs with the same CryptoKey.
const signers = new Map<string, WebCryptoSigner>();
// One ensureAccount per user at a time, whichever component asked.
const ensuring = new Map<string, Promise<string>>();
// Users whose account is being set up in this tab, for the "creating" state
// (GUEST_ID while the guest account is).
const creating = new Set<string>();
const GUEST_ID = "guest";
let guestSigner: WebCryptoSigner | null = null;
let guestEnsuring: Promise<string> | null = null;
const listeners = new Set<() => void>();

function setCreating(userId: string, on: boolean) {
  if (on) creating.add(userId);
  else creating.delete(userId);
  for (const l of listeners) l();
}

function subscribeCreating(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let supportedOnce: Promise<boolean> | null = null;
function ed25519Supported(): Promise<boolean> {
  if (!supportedOnce) supportedOnce = keyStoreAvailable() ? webCryptoEd25519Supported() : Promise.resolve(false);
  return supportedOnce;
}

async function readServer(): Promise<ServerAccount | null> {
  const res = await fetch("/api/near/account", { credentials: "same-origin", cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as Partial<ServerAccount> & { error?: string };
  if (res.status === 401) return null;
  if (!res.ok) throw new NearAccountError(body.error ?? `http_${res.status}`);
  if (!body.accountId) return null;
  return { accountId: body.accountId, publicKey: body.publicKey!, state: body.state ?? "active", previousAccountIds: body.previousAccountIds ?? [] };
}

async function postAccount(publicKey: string, fresh: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch("/api/near/account", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey, fresh }),
  });
  return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Sets the account up for this browser: the stored key or a new one (always
// a new one for a fresh start), then the route. Resolves the account id.
async function setUp(userId: string, fresh: boolean): Promise<string> {
  const signer = fresh ? await createSigner(userId) : await loadOrCreateSigner(userId);
  for (let attempt = 0; attempt < 15; attempt++) {
    const { status, body } = await postAccount(signer.publicKeyString, fresh);
    if ((status === 200 || status === 201) && typeof body.accountId === "string") {
      signers.set(userId, signer);
      return body.accountId;
    }
    // Another tab is creating it: wait for that to finish.
    if (status === 409 && body.error === "in_progress") {
      await sleep(2_000);
      continue;
    }
    const code = typeof body.error === "string" ? body.error : `http_${status}`;
    throw new NearAccountError(code, ACCOUNT_ERRORS[code]);
  }
  throw new NearAccountError("timeout", "Setting up your account is taking too long. Reload the page.");
}

// The guest account: the stored one, or a new key and a POST to
// /api/near/guest. A key the server refused for good (key_used, after a
// failed creation) is replaced once.
async function setUpGuest(): Promise<string> {
  if (!(await ed25519Supported())) throw new NearAccountError("unsupported", "This browser can't hold a test account. Try a recent Chrome, Firefox or Safari.");
  let g = (await loadGuest()) ?? (await createGuestKey());
  // With the house on, a guest made before still asks the route, which
  // makes its house account.
  if (g.accountId && !HOUSE) {
    guestSigner = g.signer;
    return g.accountId;
  }
  let replaced = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = await fetch("/api/near/guest", {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: g.publicKey }),
    });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    if ((res.status === 200 || res.status === 201) && typeof body.accountId === "string") {
      await saveGuestAccount(g.publicKey, body.accountId);
      guestSigner = g.signer;
      notifyGuestChanged();
      return body.accountId;
    }
    if (res.status === 409 && body.error === "in_progress") {
      await sleep(2_000);
      continue;
    }
    if (res.status === 409 && body.error === "key_used" && !replaced) {
      replaced = true;
      g = await createGuestKey();
      continue;
    }
    const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
    throw new NearAccountError(code, GUEST_ERRORS[code] ?? ACCOUNT_ERRORS[code]);
  }
  throw new NearAccountError("timeout", "Setting up your test account is taking too long. Reload the page.");
}

const GUEST_ERRORS: Record<string, string> = {
  house_account_clash: "Your test account's trading name is already in use on chain. Try again in another browser, or sign in.",
  house_create_failed: "Your test account could not be set up just now. Try again.",
  guest_limit_ip: "Too many guest accounts from your network in the last hour. Sign in, or try again later.",
  guest_limit_day: "Today's guest accounts are used up. Sign in with Google or X to try ATNX.",
  relayer_empty: "Guest accounts are paused for a moment on our side. Try again later.",
  create_failed: "Your test account could not be set up just now. Try again.",
  key_used: "Your test account could not be set up just now. Try again.",
  server_error: "Guest accounts are unavailable right now. Sign in, or try again later.",
};

const ACCOUNT_ERRORS: Record<string, string> = {
  other_key: "Your account was set up in another browser.",
  house_account_clash: "Your trading account's name is already in use on chain, so it can't be set up. Ask us to help.",
  house_name: "Your trading account's name is too long to set up. Ask us to help.",
  house_create_failed: "Your trading account could not be set up just now. Try again.",
  account_limit: "This sign-in has started over too many times. Ask us to help.",
  create_failed: "Your account could not be set up just now. Try again.",
  bad_public_key: "This browser made an unusable key. Reload and try again.",
  signed_out: "Sign in first.",
  not_configured: "Trading is not set up on this site yet.",
  server_error: "Your account could not be set up just now. Try again later.",
};

// ----------------------------------------------------------------- hook

export interface NearAccount {
  status: NearAccountStatus;
  accountId: string | null;
  previousAccountIds: string[];
  error: string | null;
  // Signed out and using this browser's guest account (status "ready" or
  // "creating").
  isGuest: boolean;
  // The guest account this browser holds, signed in or not, or null.
  guestAccountId: string | null;
  ensureAccount: () => Promise<string>;
  startFresh: () => Promise<string>;
  // Makes (or finds) this browser's guest account. Signed-out only.
  startGuest: () => Promise<string>;
  act: (method: NearMethod, args: Record<string, unknown>) => Promise<ActResult>;
  refetch: () => void;
}

interface GuestSnapshot {
  accountId: string | null;
  supported: boolean;
  // House on: whether the guest's house account holds its key.
  houseReady?: boolean | null;
}

export function useNearAccount(): NearAccount {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();
  // The house needs its contract too; accounts are made on the rounds as
  // before either way.
  const configured = HOUSE ? isNearHouseDeployed() && isNearRoundsDeployed() : isNearRoundsDeployed();
  const isCreating = useSyncExternalStore(
    subscribeCreating,
    () => (userId ? creating.has(userId) : false),
    () => false,
  );

  const q = useQuery({
    queryKey: ["near", "account", userId],
    enabled: configured && !!userId,
    staleTime: 30_000,
    // While another tab is creating the account (or, house on, its house
    // account is not readable yet), look again every few seconds.
    refetchInterval: (query) => {
      const d = query.state.data as AccountSnapshot | undefined;
      return d?.server?.state === "creating" || d?.houseReady === false ? 3_000 : false;
    },
    queryFn: async (): Promise<AccountSnapshot> => {
      const [server, supported] = await Promise.all([readServer(), ed25519Supported()]);
      const signer = supported ? (signers.get(userId!) ?? (await loadSigner(userId!).catch(() => null))) : null;
      if (signer) signers.set(userId!, signer);
      const localKey = signer?.publicKeyString ?? null;
      if (!HOUSE) return { server, localKey, supported };
      const houseReady = server?.state === "active" && localKey === server.publicKey ? await houseReadyFor(server.accountId, localKey) : null;
      return { server, localKey, supported, houseReady };
    },
  });

  const isGuestCreating = useSyncExternalStore(
    subscribeCreating,
    () => creating.has(GUEST_ID),
    () => false,
  );
  const gq = useQuery({
    queryKey: ["near", "guest"],
    enabled: configured,
    staleTime: Infinity,
    refetchInterval: (query) => ((query.state.data as GuestSnapshot | undefined)?.houseReady === false ? 3_000 : false),
    queryFn: async (): Promise<GuestSnapshot> => {
      const supported = await ed25519Supported();
      const g = supported ? await loadGuest().catch(() => null) : null;
      if (g?.accountId) guestSigner = g.signer;
      if (!HOUSE) return { accountId: g?.accountId ?? null, supported };
      const houseReady = g?.accountId ? await houseReadyFor(g.accountId, g.publicKey) : null;
      return { accountId: g?.accountId ?? null, supported, houseReady };
    },
  });
  // A guest made in another tab.
  useEffect(() => {
    if (!configured) return;
    return onGuestChanged(() => void queryClient.invalidateQueries({ queryKey: ["near", "guest"] }));
  }, [configured, queryClient]);
  const roundsGuestId = gq.data?.accountId ?? null;
  const signedOut = configured && !authLoading && !userId;
  const isGuest = signedOut && (isGuestCreating || !!roundsGuestId);
  // House on: the guest's house account, once it holds the key.
  const guestHouseMissing = HOUSE && !!roundsGuestId && gq.data?.houseReady === false;

  const snap = q.data;
  const status: NearAccountStatus = !configured
    ? "unconfigured"
    : authLoading
      ? "loading"
      : !userId
        ? isGuestCreating
          ? "creating"
          : gq.isLoading
            ? "loading"
            : roundsGuestId
              ? guestHouseMissing
                ? "none"
                : "ready"
              : "signed-out"
        : isCreating
          ? "creating"
          : q.isLoading
            ? "loading"
            : q.error || !snap
              ? "error"
              : !snap.supported
                ? "unsupported"
                : !snap.server
                  ? "none"
                  : snap.server.state === "creating"
                    ? "creating"
                    : snap.localKey === snap.server.publicKey
                      ? HOUSE && snap.houseReady !== true
                        ? "none"
                        : "ready"
                      : "other-browser";

  const roundsAccountId = !userId ? (isGuest && roundsGuestId ? roundsGuestId : null) : snap?.server?.state === "active" ? snap.server.accountId : null;
  // The account the page trades with and links to.
  const accountId = asHouse(roundsAccountId);
  const guestAccountId = asHouse(roundsGuestId);

  const run = useCallback(
    (fresh: boolean): Promise<string> => {
      if (!userId) return Promise.reject(new NearAccountError("signed_out", ACCOUNT_ERRORS.signed_out));
      const pending = ensuring.get(userId);
      if (pending) return pending;
      setCreating(userId, true);
      const p = setUp(userId, fresh).finally(() => {
        ensuring.delete(userId);
        setCreating(userId, false);
        void queryClient.invalidateQueries({ queryKey: ["near", "account", userId] });
      });
      ensuring.set(userId, p);
      return p;
    },
    [userId, queryClient],
  );

  const ensureAccount = useCallback(() => run(false), [run]);
  const startFresh = useCallback(() => run(true), [run]);

  const startGuest = useCallback((): Promise<string> => {
    if (userId) return Promise.reject(new NearAccountError("signed_in", "You are signed in; your account is set up for you."));
    if (guestEnsuring) return guestEnsuring;
    setCreating(GUEST_ID, true);
    const p = setUpGuest()
      .then((id) => {
        // Before "creating" clears, so the page goes straight to ready (the
        // route has made the house account too when the house is on).
        queryClient.setQueryData<GuestSnapshot>(["near", "guest"], HOUSE ? { accountId: id, supported: true, houseReady: true } : { accountId: id, supported: true });
        return asHouse(id) ?? id;
      })
      .finally(() => {
        guestEnsuring = null;
        setCreating(GUEST_ID, false);
        void queryClient.invalidateQueries({ queryKey: ["near", "guest"] });
      });
    guestEnsuring = p;
    return p;
  }, [userId, queryClient]);

  const actor = useMemo(() => {
    if (status !== "ready" || !accountId) return null;
    // House on: the house account signs for the house contract.
    const target = HOUSE ? { contractId: NEAR_HOUSE, gas: HOUSE_METHOD_GAS } : {};
    if (!userId) return isGuest && guestSigner ? createActor({ accountId, signer: guestSigner, guest: true, ...target }) : null;
    const signer = signers.get(userId);
    return signer ? createActor({ accountId, signer, ...target }) : null;
  }, [status, accountId, userId, isGuest]);

  const act = useCallback(
    async (method: NearMethod, args: Record<string, unknown>) => {
      if (!actor) throw new NearActError("no_account", 0, null, null);
      const key = HOUSE ? ["near", "house"] : ["near", "rounds"];
      try {
        return await actor.act(method, args);
      } finally {
        // The RPC can lag the call by a block or two: read now and again shortly.
        void queryClient.invalidateQueries({ queryKey: key });
        setTimeout(() => void queryClient.invalidateQueries({ queryKey: key }), 2_000);
      }
    },
    [actor, queryClient],
  );

  const error = q.error ? (q.error instanceof NearAccountError ? (ACCOUNT_ERRORS[q.error.code] ?? "Your account could not be read just now.") : "Your account could not be read just now.") : null;

  return {
    status,
    accountId,
    // Earlier rounds accounts have no house account of their own.
    previousAccountIds: userId && !HOUSE ? (snap?.server?.previousAccountIds ?? []) : [],
    error: userId ? error : null,
    isGuest,
    guestAccountId,
    ensureAccount,
    startFresh,
    startGuest,
    act,
    refetch: () => void (userId ? q.refetch() : gq.refetch()),
  };
}
