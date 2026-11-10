"use client";

import { useState } from "react";
import { Help } from "@/components/house/parts";
import { friendlyNearError } from "@/lib/near/errors";
import { useNearAccount } from "./useNearAccount";

// "Try as a guest", beside the Google and X sign-in (the NEAR login modal)
// and under the ticket's sign-in button: a test account with no sign-in,
// whose key lives in this browser only (useNearAccount startGuest,
// /api/near/guest). It can take the faucet, commit, buy, claim and roll;
// starting rounds still needs a sign-in.
export function NearGuestChoice({ onReady, variant = "quiet" }: { onReady?: (accountId: string) => void; variant?: "quiet" | "modal" }) {
  const near = useNearAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (near.status === "unconfigured" || near.status === "unsupported") return null;
  // Signed in: the account comes with the sign-in.
  if (near.status !== "signed-out" && !near.isGuest) return null;

  const working = busy || near.status === "creating";

  function go() {
    if (working) return;
    setBusy(true);
    setError(null);
    near
      .startGuest()
      .then((id) => onReady?.(id))
      .catch((e) => setError(friendlyNearError(e)))
      .finally(() => setBusy(false));
  }

  const button =
    variant === "modal"
      ? "w-full py-3 rounded-lg border border-surface bg-surface text-primary font-bold text-sm hover:border-atnx-cyan/60 transition-colors flex items-center justify-center gap-3 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
      : "w-full h-10 rounded-xl border border-surface text-sm font-bold text-primary btn-quiet cursor-pointer disabled:opacity-50";

  if (near.isGuest && near.status === "ready") {
    return (
      <p className="text-[11px] text-tertiary text-center">
        You are trying ATNX as a guest, <span className="font-mono">{near.accountId}</span>.
      </p>
    );
  }

  const tryButton = (
    <button type="button" onClick={go} disabled={working} className={button}>
      {working ? "Setting up your test account…" : "Try as a guest"}
    </button>
  );

  // In the sign-in modal the line stays under the button; under a ticket's
  // sign-in, and in Settings, it is the note of the "?" beside it.
  if (variant === "modal") {
    return (
      <div>
        {tryButton}
        <p className="text-[11px] text-tertiary mt-1.5 text-center">{LIVES_HERE}</p>
        {error && <p className="text-xs text-atnx-magenta mt-2 break-words text-center">{error}</p>}
      </div>
    );
  }
  return (
    <div>
      <Help label="About the guest account" note={LIVES_HERE}>
        {(help) => (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">{tryButton}</div>
            {help}
          </div>
        )}
      </Help>
      {error && <p className="text-sm text-atnx-magenta light:text-atnx-magenta-light mt-2 break-words text-center">{error}</p>}
    </div>
  );
}

const LIVES_HERE = "Your test account lives in this browser.";
