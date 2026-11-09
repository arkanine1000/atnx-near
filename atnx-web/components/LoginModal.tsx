"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { useAuth, type OAuthProvider } from "@/context/AuthContext";
import { shortAddress } from "@/components/bm/format";
import { isNearChain } from "@/lib/near/config";

// Sign in with the wallet: connect (if not already), then one signature.
// The hackathon build has no Google or X sign-in; the wallet is the
// identity for trading, opening markets and capturing. The NEAR build
// (NEXT_PUBLIC_BM_CHAIN=near) signs in with Google or X instead, and the
// rounds account comes with the sign-in (NearLoginModal below).
export function LoginModal() {
  if (isNearChain()) return <NearLoginModal />;
  return <WalletLoginModal />;
}

function WalletLoginModal() {
  const { isLoginModalOpen, closeLoginModal, signInWithWallet } = useAuth();
  const { address, chainId, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoginModalOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeLoginModal();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isLoginModalOpen, closeLoginModal]);

  if (!isLoginModalOpen) return null;

  const named = connectors.filter((c) => c.id !== "injected");
  const choices = named.length > 0 ? named : connectors;

  async function sign() {
    if (!address || !chainId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithWallet({ address, chainId, sign: (message) => signMessageAsync({ message }) });
    } catch (err) {
      setError(friendly((err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const buttonClass =
    "w-full py-3 rounded-lg border border-surface bg-surface text-primary font-bold text-sm hover:border-atnx-cyan/60 transition-colors flex items-center justify-center gap-3 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)" }}
      onClick={closeLoginModal}
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-modal-title"
    >
      <div className="bg-elevated border border-surface rounded-xl p-6 w-full max-w-sm mx-4 relative" onClick={(e) => e.stopPropagation()}>
        <button onClick={closeLoginModal} aria-label="Close" className="absolute top-4 right-4 text-secondary link-quiet text-lg cursor-pointer">
          {"\u2715"}
        </button>
        <h2 id="login-modal-title" className="font-display text-lg font-bold text-atnx-cyan mb-1">
          Sign in with your wallet
        </h2>
        <p className="text-xs text-secondary mb-5">
          {isConnected
            ? "One signature proves you hold the connected address. No transaction, no gas."
            : "Connect a wallet, then sign one message. No transaction, no gas."}
        </p>

        <div className="flex flex-col gap-3">
          {isConnected && address ? (
            <button onClick={sign} disabled={busy} className={buttonClass}>
              {busy ? "Check your wallet…" : `Sign in as ${shortAddress(address)}`}
            </button>
          ) : (
            choices.map((c) => (
              <button key={c.uid} onClick={() => connect({ connector: c })} disabled={connecting} className={buttonClass}>
                {connecting ? "Connecting…" : c.name}
              </button>
            ))
          )}
          {choices.length === 0 && <p className="text-xs text-tertiary">No wallet extension found in this browser.</p>}
        </div>

        <p className="text-[11px] text-tertiary mt-4 text-center">
          By continuing you agree to the{" "}
          <a href="/terms" target="_blank" rel="noopener" className="underline link-soft">Terms</a> and{" "}
          <a href="/privacy" target="_blank" rel="noopener" className="underline link-soft">Privacy Policy</a>.
        </p>

        {(error || connectError) && (
          <div className="mt-3 text-xs text-atnx-magenta border border-atnx-magenta/40 bg-atnx-magenta/10 rounded px-3 py-2">
            {error ?? friendly(connectError!.message)}
          </div>
        )}
      </div>
    </div>
  );
}

function friendly(msg: string): string {
  const m = msg.split("\n")[0];
  if (/rejected|denied|cancel/i.test(m)) return "The wallet refused. Try again and approve the signature.";
  if (/web3.*disabled|provider.*disabled|unsupported/i.test(m)) return "Wallet sign-in is not enabled on the auth server yet.";
  return m.slice(0, 160);
}

// ------------------------------------------------------------- NEAR build

// "Try as a guest", loaded only in the NEAR build: it brings the NEAR signer,
// which the Solana build does not carry.
const NearGuestChoice = dynamic(() => import("@/components/rounds/NearGuestChoice").then((m) => m.NearGuestChoice), {
  ssr: false,
  loading: () => (
    <button type="button" disabled className="w-full py-3 rounded-lg border border-surface bg-surface text-primary font-bold text-sm opacity-60">
      Try as a guest
    </button>
  ),
});

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", x: "X" };

function NearLoginModal() {
  const { isLoginModalOpen, closeLoginModal, signInWithOAuth } = useAuth();
  // The provider whose redirect is in flight; both buttons wait meanwhile.
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoginModalOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeLoginModal();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isLoginModalOpen, closeLoginModal]);

  if (!isLoginModalOpen) return null;

  async function go(provider: OAuthProvider) {
    if (busy) return;
    setBusy(provider);
    setError(null);
    try {
      // A full-page redirect follows; stay busy until it happens.
      await signInWithOAuth(provider);
    } catch {
      setError(`Could not start ${PROVIDER_LABEL[provider]} sign-in. Please try again.`);
      setBusy(null);
    }
  }

  const buttonClass =
    "w-full py-3 rounded-lg border border-surface bg-surface text-primary font-bold text-sm hover:border-atnx-cyan/60 transition-colors flex items-center justify-center gap-3 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)" }}
      onClick={closeLoginModal}
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-modal-title"
    >
      <div className="bg-elevated border border-surface rounded-xl p-6 w-full max-w-sm mx-4 relative" onClick={(e) => e.stopPropagation()}>
        <button onClick={closeLoginModal} aria-label="Close" className="absolute top-4 right-4 text-secondary link-quiet text-lg cursor-pointer">
          {"\u2715"}
        </button>
        <h2 id="login-modal-title" className="font-display text-lg font-bold text-atnx-cyan mb-1">
          Sign in to ATNX
        </h2>
        <p className="text-xs text-secondary mb-5">Sign in to take a side. Your trading account is set up for you; there is nothing to install and nothing to pay.</p>

        <div className="flex flex-col gap-3">
          <button onClick={() => go("google")} disabled={busy !== null} className={buttonClass}>
            <GoogleIcon />
            <span>{busy === "google" ? "Redirecting\u2026" : "Continue with Google"}</span>
          </button>
          <button onClick={() => go("x")} disabled={busy !== null} className={buttonClass}>
            <XIcon />
            <span>{busy === "x" ? "Redirecting\u2026" : "Continue with X"}</span>
          </button>
          <div className="flex items-center gap-3 text-[11px] text-tertiary" aria-hidden="true">
            <span className="flex-1 border-t border-surface" />
            or
            <span className="flex-1 border-t border-surface" />
          </div>
          <NearGuestChoice variant="modal" onReady={closeLoginModal} />
        </div>

        <p className="text-[11px] text-tertiary mt-4 text-center">
          By continuing you agree to the{" "}
          <a href="/terms" target="_blank" rel="noopener" className="underline link-soft">Terms</a> and{" "}
          <a href="/privacy" target="_blank" rel="noopener" className="underline link-soft">Privacy Policy</a>.
        </p>

        {error && <div className="mt-3 text-xs text-atnx-magenta border border-atnx-magenta/40 bg-atnx-magenta/10 rounded px-3 py-2">{error}</div>}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.1l6.6 4.8C14.6 15.1 18.9 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.1z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.6 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.6 16.3 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.7l6.2 5.2c-.4.4 6.6-4.8 6.6-14.9 0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
