"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtUsdg } from "@/components/bm/format";
import { Help } from "@/components/house/parts";
import { useAuth } from "@/context/AuthContext";
import { faucetArgs } from "@/lib/bm/house-types";
import { FAUCET_UNITS, HOUSE_FAUCET_UNITS, isHouseProduct, isNearHouseDeployed, isNearRoundsDeployed, nearAccountUrl } from "@/lib/near/config";
import { friendlyNearError } from "@/lib/near/errors";
import { nearHouseViewer } from "@/lib/near/house";
import { callArgs } from "@/lib/near/rounds";
import { FundFromAnyChain } from "./FundFromAnyChain";
import { NearGuestChoice } from "./NearGuestChoice";
import { useNearAccount } from "./useNearAccount";
import { nearViewer } from "./useNearRounds";

// The NEAR block of Settings: the trading account ATNX set up for this
// sign-in, with a link to it on the explorer, its test USDG, the faucet,
// a preview of funding it with USDC from another chain (FundFromAnyChain,
// dry NEAR Intents quotes), and, in plain words, what happens if this
// browser's key is lost: there is no recovery, a new account starts empty
// (one line on screen, the rest behind its "?").
//
// Signed out, the same block shows this browser's guest account, with a way
// to sign in, or offers one ("Try as a guest"). Signed in, a guest account
// still in this browser is named at the bottom: it stays separate.
//
// With the house on (NEXT_PUBLIC_BM_NEAR_PRODUCT=house) the account is the
// house account, and the balance and the faucet are the house contract's:
// up to 10,000 test USDG per account in all.
const HOUSE = isHouseProduct();

export function NearAccountSettings() {
  const near = useNearAccount();
  const { user, openLoginModal } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const accountId = near.accountId;

  const balance = useQuery({
    queryKey: HOUSE ? ["near", "house", "usdg", accountId] : ["near", "rounds", "usdg", accountId],
    enabled: !!accountId && (HOUSE ? isNearHouseDeployed() : isNearRoundsDeployed()),
    refetchInterval: 15_000,
    queryFn: () => (HOUSE ? nearHouseViewer().balanceOf(accountId!) : nearViewer().balanceOf(accountId!)),
  });
  // The house faucet's allowance left for this account.
  const claimed = useQuery({
    queryKey: ["near", "house", "claimed", accountId],
    enabled: HOUSE && !!accountId && isNearHouseDeployed(),
    refetchInterval: 60_000,
    queryFn: async () => {
      const v = nearHouseViewer();
      const [cfg, used] = await Promise.all([v.config(), v.faucetClaimed(accountId!)]);
      return cfg.faucetPerAccount !== null && used !== null ? cfg.faucetPerAccount - used : HOUSE_FAUCET_UNITS;
    },
  });
  const houseFaucet = claimed.data === undefined ? HOUSE_FAUCET_UNITS : claimed.data > HOUSE_FAUCET_UNITS ? HOUSE_FAUCET_UNITS : claimed.data < 0n ? 0n : claimed.data;

  async function faucet() {
    setBusy("faucet");
    setNote(null);
    try {
      if (HOUSE) {
        await near.act("faucet", faucetArgs(houseFaucet));
        void claimed.refetch();
      } else {
        await near.act("faucet", callArgs.faucet(FAUCET_UNITS));
      }
      void balance.refetch();
      setNote(HOUSE ? `Got ${fmtUsdg(houseFaucet, 0)} test USDG.` : "Got 1,000 test USDG.");
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
      await (fresh ? near.startFresh() : near.isGuest ? near.startGuest() : near.ensureAccount());
    } catch (err) {
      setNote(friendlyNearError(err));
    } finally {
      setBusy(null);
    }
  }

  if (HOUSE && !isNearHouseDeployed()) return <p className="text-sm text-secondary">Trading is not live on NEAR testnet yet.</p>;
  if (!isNearRoundsDeployed()) return <p className="text-sm text-secondary">Rounds are not live on NEAR testnet yet.</p>;

  const row = "flex items-center justify-between gap-3 py-3 border-b border-surface last:border-b-0 text-sm";
  const pill = "h-9 px-4 rounded-full text-sm font-bold cursor-pointer whitespace-nowrap";
  // What a lost key means, one line on screen and the rest behind its "?".
  const lostKey = (
    <div className="py-3">
      <Help
        label={near.isGuest ? "About the guest account" : "About the trading account"}
        note={
          near.isGuest
            ? "If you clear its data, or open ATNX in another browser, it is gone for you; whatever it holds stays with it, and nobody, ATNX included, can move it back."
            : "If you clear its data, or sign in from another browser, ATNX sets up a new, empty account; whatever the old one holds stays with it, and nobody, ATNX included, can move it back."
        }
      >
        {(help) => (
          <p className="flex items-center gap-2 text-sm text-secondary">
            {near.isGuest ? "This guest account lives only in this browser." : "Your trading account is tied to this browser."}
            {help}
          </p>
        )}
      </Help>
    </div>
  );
  const separateGuest =
    user && near.guestAccountId ? (
      <p className="text-sm text-secondary pt-3">
        This browser also holds a guest account,{" "}
        <a href={nearAccountUrl(near.guestAccountId)} target="_blank" rel="noreferrer" className="font-mono break-all link-quiet underline underline-offset-2">
          {near.guestAccountId}
        </a>
        . It stays separate from your sign-in; sign out to use it again.
      </p>
    ) : null;

  if (near.status === "loading" && user) return <p className="text-sm text-secondary animate-pulse">Reading your account…</p>;
  if (near.status === "signed-out" || near.status === "loading") {
    return (
      <div>
        <p className="text-sm text-secondary mb-3">{HOUSE ? "Sign in to get a trading account." : "Sign in to get a trading account for the rounds."} There is nothing to install and nothing to pay.</p>
        <button type="button" onClick={openLoginModal} disabled={near.status === "loading"} className={`${pill} btn-cyan disabled:opacity-40`}>
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
  if (near.isGuest && near.status === "creating") return <p className="text-sm text-secondary animate-pulse">Setting up your test account…</p>;

  if (near.status === "unsupported") {
    return <p className="text-sm text-secondary">This browser can&apos;t hold your trading account. Try a recent Chrome, Firefox or Safari.</p>;
  }

  if (near.status === "none" || near.status === "creating" || (near.status === "error" && !accountId)) {
    return (
      <div>
        <p className="text-sm text-secondary mb-3">
          {near.status === "creating" ? "Setting up your account…" : near.status === "error" ? (near.error ?? "Your account could not be read just now.") : "You don't have a trading account yet. It is set up the first time you trade, or here."}
        </p>
        {near.status !== "creating" && (
          <button type="button" disabled={!!busy} onClick={() => (near.status === "error" ? near.refetch() : void setUp(false))} className={`${pill} btn-cyan disabled:opacity-40`}>
            {busy === "setup" ? "Setting up…" : near.status === "error" ? "Try again" : "Set up my account"}
          </button>
        )}
        {note && <p className="text-sm text-secondary py-2 break-words">{note}</p>}
        {lostKey}
      </div>
    );
  }

  return (
    <div>
      {near.isGuest && (
        <div className="pb-3 border-b border-surface">
          <p className="text-sm text-primary mb-2.5">You&apos;re a guest. Sign in with Google or X to keep an account.</p>
          <button type="button" onClick={openLoginModal} className={`${pill} btn-cyan`}>
            Sign in
          </button>
        </div>
      )}
      {accountId && (
        <div className={row}>
          <span className="text-secondary shrink-0">{near.isGuest ? "Guest account" : "Account"}</span>
          <a href={nearAccountUrl(accountId)} target="_blank" rel="noreferrer" className="font-mono text-primary link-quiet break-all text-right" title={accountId}>
            {accountId} ↗
          </a>
        </div>
      )}
      <div className={row}>
        <div>
          <div className="text-primary font-bold">Test USDG</div>
          <div className="mt-0.5 text-secondary">
            {balance.data !== undefined ? (
              <>
                <span className="text-base font-semibold tabular-nums text-primary">{fmtUsdg(balance.data)}</span> in the account
              </>
            ) : (
              "reading…"
            )}
          </div>
        </div>
        <button
          type="button"
          disabled={!!busy || near.status !== "ready" || (HOUSE && houseFaucet <= 0n)}
          onClick={faucet}
          title={HOUSE && houseFaucet <= 0n ? "This account has had all the test USDG it can get." : undefined}
          className={`${pill} btn-cyan disabled:opacity-50`}
        >
          {busy === "faucet" ? "Getting…" : HOUSE ? (houseFaucet > 0n ? `Get ${fmtUsdg(houseFaucet, 0)}` : "All claimed") : "Get 1,000"}
        </button>
      </div>
      {near.status === "other-browser" && (
        <div className="py-3 border-b border-surface">
          <p className="text-sm text-secondary mb-2.5">This account was set up in another browser, which holds its key. To trade here, start a new account; this one keeps what it holds.</p>
          <button type="button" disabled={!!busy} onClick={() => void setUp(true)} className={`${pill} border border-surface text-primary btn-quiet disabled:opacity-40`}>
            {busy === "setup" ? "Setting up…" : "Start a new account here"}
          </button>
        </div>
      )}
      {note && <p className="text-sm text-secondary py-2 break-words">{note}</p>}
      <FundFromAnyChain />
      {near.previousAccountIds.length > 0 && (
        <p className="text-sm text-secondary pt-3">
          Earlier accounts:{" "}
          {near.previousAccountIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <a href={nearAccountUrl(id)} target="_blank" rel="noreferrer" className="font-mono break-all link-quiet underline underline-offset-2">
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
