"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { friendlyNearError } from "@/lib/near/errors";
import { NearGuestChoice } from "./NearGuestChoice";
import type { NearAccount } from "./useNearAccount";

// What stands between a NEAR ticket and the user, shared by the rounds
// ticket (NearRoundTicket) and the house ticket (components/house): the
// sign-in (or "Try as a guest"), the account being set up, an account whose
// key is in another browser, a browser that can't hold a key.

const BUTTON = "btn-cyan w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50";

// Sets the account up once, on its own, when a signed-in user without one
// opens a ticket that needs it. With the house on, a guest whose house
// account is not there yet is "none" too, and is set up the same way.
export function useAutoAccount(near: NearAccount, enabled: boolean) {
  const tried = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || near.status !== "none" || tried.current) return;
    tried.current = true;
    (near.isGuest ? near.startGuest() : near.ensureAccount()).catch((e) => setError(friendlyNearError(e)));
  }, [enabled, near]);
  const retry = () => {
    setError(null);
    (near.isGuest ? near.startGuest() : near.ensureAccount()).catch((e) => setError(friendlyNearError(e)));
  };
  return { error, retry };
}

// What stands between the user and the ticket: signing in (or, where
// `guest` is set, trying it as a guest), the account being set up, or an
// account whose key is in another browser.
export function AccountGate({ near, label, autoError, onRetry, guest = false }: { near: NearAccount; label: string; autoError: string | null; onRetry: () => void; guest?: boolean }) {
  const { user, openLoginModal } = useAuth();
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  switch (near.status) {
    case "loading":
      // Signed in, reading the account; before the session is known, the
      // sign-in button (disabled) holds the place.
      if (user) return <p className="text-sm text-secondary animate-pulse">Loading your account…</p>;
      return (
        <button type="button" disabled className={BUTTON}>
          {label}
        </button>
      );
    case "signed-out":
      return (
        <>
          <button type="button" onClick={openLoginModal} className={BUTTON}>
            {label}
          </button>
          {guest && (
            <div className="mt-2.5">
              <NearGuestChoice />
            </div>
          )}
        </>
      );
    case "none":
    case "creating":
      if (autoError && near.status === "none") {
        return (
          <>
            <p className="text-xs text-atnx-magenta mb-3 break-words">{autoError}</p>
            <button type="button" onClick={onRetry} className={BUTTON}>
              Try again
            </button>
          </>
        );
      }
      if (near.isGuest) return <p className="text-sm text-secondary animate-pulse">Setting up your test account…</p>;
      return <p className="text-sm text-secondary animate-pulse">Setting up your account…</p>;
    case "other-browser":
      return (
        <>
          <p className="text-xs text-secondary mb-3">Your account was set up in another browser. Start a new one here to trade; the old one keeps what it holds.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFresh(null);
              near
                .startFresh()
                .catch((e) => setFresh(friendlyNearError(e)))
                .finally(() => setBusy(false));
            }}
            className={BUTTON}
          >
            {busy ? "Setting up your account…" : "Start a new account here"}
          </button>
          {fresh && <p className="text-xs text-atnx-magenta mt-3 break-words">{fresh}</p>}
        </>
      );
    case "unsupported":
      return <p className="text-sm text-secondary">This browser can&apos;t hold your trading account. Try a recent Chrome, Firefox or Safari.</p>;
    case "error":
      return (
        <>
          <p className="text-xs text-atnx-magenta mb-3">{near.error ?? "Your account could not be read just now."}</p>
          <button type="button" onClick={near.refetch} className={BUTTON}>
            Try again
          </button>
        </>
      );
    default:
      return null;
  }
}
