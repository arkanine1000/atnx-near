"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { NearActError, createActor, type ActResult } from "@/lib/near/client";
import { isNearRoundsDeployed, type UserMethod } from "@/lib/near/config";
import { createSigner, keyStoreAvailable, loadOrCreateSigner, loadSigner } from "@/lib/near/keystore";
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
// Users whose account is being set up in this tab, for the "creating" state.
const creating = new Set<string>();
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

const ACCOUNT_ERRORS: Record<string, string> = {
  other_key: "Your account was set up in another browser.",
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
  ensureAccount: () => Promise<string>;
  startFresh: () => Promise<string>;
  act: (method: UserMethod, args: Record<string, unknown>) => Promise<ActResult>;
  refetch: () => void;
}

export function useNearAccount(): NearAccount {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();
  const configured = isNearRoundsDeployed();
  const isCreating = useSyncExternalStore(
    subscribeCreating,
    () => (userId ? creating.has(userId) : false),
    () => false,
  );

  const q = useQuery({
    queryKey: ["near", "account", userId],
    enabled: configured && !!userId,
    staleTime: 30_000,
    // While another tab is creating the account, look again every few seconds.
    refetchInterval: (query) => ((query.state.data as AccountSnapshot | undefined)?.server?.state === "creating" ? 3_000 : false),
    queryFn: async (): Promise<AccountSnapshot> => {
      const [server, supported] = await Promise.all([readServer(), ed25519Supported()]);
      const signer = supported ? (signers.get(userId!) ?? (await loadSigner(userId!).catch(() => null))) : null;
      if (signer) signers.set(userId!, signer);
      return { server, localKey: signer?.publicKeyString ?? null, supported };
    },
  });

  const snap = q.data;
  const status: NearAccountStatus = !configured
    ? "unconfigured"
    : authLoading
      ? "loading"
      : !userId
        ? "signed-out"
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
                      ? "ready"
                      : "other-browser";

  const accountId = snap?.server?.state === "active" ? snap.server.accountId : null;

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

  const actor = useMemo(() => {
    if (status !== "ready" || !accountId || !userId) return null;
    const signer = signers.get(userId);
    return signer ? createActor({ accountId, signer }) : null;
  }, [status, accountId, userId]);

  const act = useCallback(
    async (method: UserMethod, args: Record<string, unknown>) => {
      if (!actor) throw new NearActError("no_account", 0, null, null);
      try {
        return await actor.act(method, args);
      } finally {
        // The RPC can lag the call by a block or two: read now and again shortly.
        void queryClient.invalidateQueries({ queryKey: ["near", "rounds"] });
        setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["near", "rounds"] }), 2_000);
      }
    },
    [actor, queryClient],
  );

  const error = q.error ? (q.error instanceof NearAccountError ? (ACCOUNT_ERRORS[q.error.code] ?? "Your account could not be read just now.") : "Your account could not be read just now.") : null;

  return {
    status,
    accountId,
    previousAccountIds: snap?.server?.previousAccountIds ?? [],
    error,
    ensureAccount,
    startFresh,
    act,
    refetch: () => void q.refetch(),
  };
}
