"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtUsdg } from "@/components/bm/format";
import { useAuth } from "@/context/AuthContext";
import { FAUCET_UNITS, isNearRoundsDeployed, nearAccountUrl } from "@/lib/near/config";
import { friendlyNearError } from "@/lib/near/errors";
import { callArgs } from "@/lib/near/rounds";
import { FundFromAnyChain } from "./FundFromAnyChain";
import { NearGuestChoice } from "./NearGuestChoice";
import { useNearAccount } from "./useNearAccount";
import { nearViewer } from "./useNearRounds";

// The NEAR block of Settings: the trading account ATNX set up for this
// sign-in, with a link to it on the explorer, its test USDG, the faucet,
// a preview of funding it with USDC from another chain (FundFromAnyChain,
// dry NEAR Intents quotes), and, in plain words, what happens if this
// browser's key is lost: there is no recovery, a new account starts empty.
//
// Signed out, the same block shows this browser's guest account, with a way
// to sign in, or offers one ("Try as a guest"). Signed in, a guest account
// still in this browser is named at the bottom: it stays separate.
export function NearAccountSettings() {
  const near = useNearAccount();
  const { user, openLoginModal } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const accountId = near.accountId;

  const balance = useQuery({
    queryKey: ["near", "rounds", "usdg", accountId],
    enabled: !!accountId && isNearRoundsDeployed(),
    refetchInterval: 15_000,
    queryFn: () => nearViewer().balanceOf(accountId!),
  });

  async function faucet() {
    setBusy("faucet");
    setNote(null);
    try {
      await near.act("faucet", callArgs.faucet(FAUCET_UNITS));
      void balance.refetch();
      setNote("Got 1,000 test USDG.");
    } catch (err) {
      setNote(friendlyNearError(err));
    } finally {
      setBusy(null);
    }
  }

  async function setUp(fresh: boolean) {
    setBusy("setup");
    setNote(null);
    try {
      await (fresh ? near.startFresh() : near.ensureAccount());
    } catch (err) {
      setNote(friendlyNearError(err));
    } finally {
      setBusy(null);
    }
  }

  if (!isNearRoundsDeployed()) return <p className="text-xs text-secondary">Rounds are not live on NEAR testnet yet.</p>;

  const row = "flex items-center justify-between gap-3 py-2.5 border-b border-surface last:border-b-0 text-xs";
  const lostKey = near.isGuest ? (
    <p className="text-[11px] text-tertiary py-2.5">
      Your guest account lives only in this browser. If you clear its data, or open ATNX in another browser, it is gone for you; whatever it holds stays with it, and
      nobody, ATNX included, can move it back.
    </p>
  ) : (
    <p className="text-[11px] text-tertiary py-2.5">
      Your trading account is tied to this browser. If you clear its data, or sign in from another browser, ATNX sets up a new, empty account; whatever the old one
      holds stays with it, and nobody, ATNX included, can move it back.
    </p>
  );
  const separateGuest =
    user && near.guestAccountId ? (
      <p className="text-[11px] text-tertiary pt-2.5">
        This browser also holds a guest account,{" "}
        <a href={nearAccountUrl(near.guestAccountId)} target="_blank" rel="noreferrer" className="font-mono link-quiet">
          {near.guestAccountId}
        </a>
        . It stays separate from your sign-in; sign out to use it again.
      </p>
    ) : null;

  if (near.status === "loading" && user) return <p className="text-xs text-secondary animate-pulse">Reading your account…</p>;
  if (near.status === "signed-out" || near.status === "loading") {
    return (
      <div>
        <p className="text-xs text-secondary mb-3">Sign in to get a trading account for the rounds. There is nothing to install and nothing to pay.</p>
        <button type="button" onClick={openLoginModal} disabled={near.status === "loading"} className="h-8 px-3 rounded-full btn-cyan text-xs font-bold cursor-pointer disabled:opacity-40">
          Sign in
        </button>
        {near.status === "signed-out" && (
          <div className="mt-4 max-w-xs">
            <NearGuestChoice />
          </div>
        )}
      </div>
    );
  }
  if (near.isGuest && near.status === "creating") return <p className="text-xs text-secondary animate-pulse">Setting up your test account…</p>;

  if (near.status === "unsupported") {
    return <p className="text-xs text-secondary">This browser can&apos;t hold your trading account. Try a recent Chrome, Firefox or Safari.</p>;
  }

  if (near.status === "none" || near.status === "creating" || (near.status === "error" && !accountId)) {
    return (
      <div>
        <p className="text-xs text-secondary mb-3">
          {near.status === "creating" ? "Setting up your account…" : near.status === "error" ? (near.error ?? "Your account could not be read just now.") : "You don't have a trading account yet. It is set up the first time you trade, or here."}
        </p>
        {near.status !== "creating" && (
          <button type="button" disabled={!!busy} onClick={() => (near.status === "error" ? near.refetch() : void setUp(false))} className="h-8 px-3 rounded-full btn-cyan text-xs font-bold cursor-pointer disabled:opacity-40">
            {busy === "setup" ? "Setting up…" : near.status === "error" ? "Try again" : "Set up my account"}
          </button>
        )}
        {note && <p className="text-[11px] text-secondary py-2 break-words">{note}</p>}
        {lostKey}
      </div>
    );
  }

  return (
    <div>
      {near.isGuest && (
        <div className="py-2.5 border-b border-surface">
          <p className="text-xs text-secondary mb-2">You are trying ATNX as a guest, with no sign-in. Sign in with Google or X for an account you can come back to; this guest account stays in this browser, separate.</p>
          <button type="button" onClick={openLoginModal} className="h-8 px-3 rounded-full btn-cyan text-xs font-bold cursor-pointer">
            Sign in
          </button>
        </div>
      )}
      {accountId && (
        <div className={row}>
          <span className="text-tertiary">{near.isGuest ? "Guest account" : "Account"}</span>
          <a href={nearAccountUrl(accountId)} target="_blank" rel="noreferrer" className="font-mono text-primary link-quiet break-all text-right" title={accountId}>
            {accountId} ↗
          </a>
        </div>
      )}
      <div className={row}>
        <div>
          <div className="text-primary">Test USDG</div>
          <div className="text-tertiary mt-0.5 tabular-nums">{balance.data !== undefined ? `${fmtUsdg(balance.data)} in the account` : "reading…"}</div>
        </div>
        <button
          type="button"
          disabled={!!busy || near.status !== "ready"}
          onClick={faucet}
          className="h-8 px-3 rounded-full btn-cyan text-xs font-bold cursor-pointer disabled:opacity-40 whitespace-nowrap"
        >
          {busy === "faucet" ? "Getting…" : "Get 1,000"}
        </button>
      </div>
      {near.status === "other-browser" && (
        <div className="py-2.5 border-b border-surface">
          <p className="text-xs text-secondary mb-2">This account was set up in another browser, which holds its key. To trade here, start a new account; this one keeps what it holds.</p>
          <button type="button" disabled={!!busy} onClick={() => void setUp(true)} className="h-8 px-3 rounded-full border border-surface text-xs font-bold text-primary btn-quiet cursor-pointer disabled:opacity-40">
            {busy === "setup" ? "Setting up…" : "Start a new account here"}
          </button>
        </div>
      )}
      {note && <p className="text-[11px] text-secondary py-2 break-words">{note}</p>}
      <FundFromAnyChain />
      {near.previousAccountIds.length > 0 && (
        <p className="text-[11px] text-tertiary pt-2.5">
          Earlier accounts:{" "}
          {near.previousAccountIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <a href={nearAccountUrl(id)} target="_blank" rel="noreferrer" className="font-mono link-quiet">
                {id}
              </a>
            </span>
          ))}
        </p>
      )}
      {lostKey}
      {separateGuest}
    </div>
  );
}
