"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { createClient } from "@/lib/supabase/client";

// What the Create pages show when the server finds no signed-in user.
// A market belongs to the account that created it, so creating needs a
// Google or X sign-in; a guest account can trade but not create. The
// sign-in returns to this same page.
//
// The server can also miss a session the browser still holds, when the
// cookie it was sent had just expired. If the browser's own check finds a
// user, the page is asked for once more with the cookie the browser has by
// then rewritten. One try per page and minute, so it can never loop.
const RETRY_KEY = "atnx-create-retry";

export function CreateSignIn({ heading = "Create" }: { heading?: string }) {
  const { openLoginModal } = useAuth();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const key = `${RETRY_KEY}:${window.location.pathname}`;
    let last = 0;
    try {
      last = Number(window.sessionStorage.getItem(key) ?? 0);
    } catch {
      // No session storage: skip the retry and show the prompt.
      return;
    }
    if (Date.now() - last < 60_000) return;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (cancelled || !data.user) return;
        try {
          window.sessionStorage.setItem(key, String(Date.now()));
        } catch {
          return;
        }
        router.refresh();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="max-w-2xl mx-auto w-full">
      <h1 className="font-display text-xl font-bold text-primary mb-1">{heading}</h1>
      <p className="text-sm text-secondary mb-5">
        Creating a market needs a Google or X sign-in. A guest account can trade, but a market
        belongs to the account that created it.
      </p>
      <button
        type="button"
        onClick={openLoginModal}
        className="h-10 px-5 inline-flex items-center rounded-full btn-magenta text-sm font-bold"
      >
        Sign in to create
      </button>
    </div>
  );
}
