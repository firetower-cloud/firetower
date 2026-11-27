"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mark } from "./Signal";
import { useLogin } from "@/src/api/generated/auth/auth";
import { setupState } from "@/src/api/generated/setup/setup";
import { afterSignIn, ApiError, leaveFor, rememberToken, toApplication } from "@/src/api/http";
import { useQueryClient } from "@tanstack/react-query";

/**
 * The only screen anybody sees before signing in.
 *
 * There is no "create an account" here on purpose: the administrator exists
 * before this control plane answers its first request, made from
 * `ADMIN_USERNAME` and `ADMIN_INITIAL_PASSWORD` or invented and printed once in
 * the log. A Firetower on a public address is never briefly unclaimed, waiting
 * for whoever finds it first.
 */
export function SignIn() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [failed, setFailed] = useState<string | null>(null);

  const login = useLogin();
  const cache = useQueryClient();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailed(null);

    login.mutate(
      { data: { username, password } },
      {
        onSuccess: async ({ token }) => {
          rememberToken(token);
          // Anything asked before signing in was answered "who are you?";
          // asked again now, it is answered.
          cache.clear();

          // Where to land is "is setting up finished?", not "is this password
          // temporary?". Routing on the password alone meant that after the
          // first step — which clears it — you were sent to the home page while the
          // organisation was still unnamed, with nothing to take you back.
          //
          // `needsGithub` is deliberately not part of this. It is skippable,
          // and anyone who skipped it would be dragged back here on every
          // sign-in until they registered an application they may not want.
          //
          // **`?next=` is asked second, never first.** A password that is
          // still owed outranks anywhere somebody wanted to be: `/setup` is
          // the screen that fixes it and every other request is refused until
          // it has been, so routing past it on the strength of a query
          // parameter would land them on a page that immediately bounces them
          // back here. Setting up outstanding wins, then where they were
          // going, then the application.
          //
          // The hops are not the same kind. `/setup` is this site's own page
          // and the router reaches it; the other two may name either bundle —
          // `/` is certainly the renderer's — so they load a document. See
          // `afterSignIn` and `leaveFor`.
          try {
            const state = await setupState();
            // Read at the moment of leaving rather than held in state:
            // nothing between arriving here and signing in can change the
            // address, and a copy of it is a second thing to keep right.
            const where = afterSignIn(
              state.needsPassword || state.needsOrganization,
              window.location.search,
              window.location.origin,
            );
            if (where.to === "setup") router.replace("/setup");
            else leaveFor(where.path);
          } catch {
            // If that call fails, the application is the safer guess — it
            // renders its own errors, where a wizard would be asking questions
            // it cannot save the answers to. Not `?next=` either: with nothing
            // known about what is outstanding, the parameter is the one input
            // here that somebody else wrote, and the unknown state is not the
            // moment to start trusting it.
            toApplication();
          }
        },
        onError: (error) => {
          setFailed(
            error instanceof ApiError
              ? error.message
              : "The control plane didn't answer.",
          );
        },
      },
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-8">
      <div className="w-full max-w-[340px]">
        <div className="flex items-center gap-2.5">
          <span className="text-bone">
            <Mark size={22} />
          </span>
          <span className="font-narrow text-ui font-semibold tracking-[0.22em] text-bone uppercase">
            Firetower
          </span>
        </div>

        <form onSubmit={submit} className="mt-8">
          <label className="block text-meta text-mute" htmlFor="username">
            Username
          </label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1.5 w-full rounded border border-line bg-transparent px-3 py-2 text-ui text-bone outline-none focus:border-dim"
          />

          <label className="mt-4 block text-meta text-mute" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 w-full rounded border border-line bg-transparent px-3 py-2 text-ui text-bone outline-none focus:border-dim"
          />

          {failed && (
            <p className="mt-3 text-meta text-brick" role="alert">
              {failed}
            </p>
          )}

          <button
            type="submit"
            disabled={login.isPending || !username || !password}
            className="mt-5 w-full rounded-md bg-bone px-3 py-2 text-ui font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
          >
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-meta leading-[1.6] text-mute">
          Your initial password is the one chosen at the end of the CLI installation.
        </p>
      </div>
    </div>
  );
}
