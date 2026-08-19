"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mark } from "./Signal";
import { useLogin } from "@/src/api/generated/auth/auth";
import { setupState } from "@/src/api/generated/setup/setup";
import { ApiError, rememberToken } from "@/src/api/http";

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

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailed(null);

    login.mutate(
      { data: { username, password } },
      {
        onSuccess: async ({ token }) => {
          rememberToken(token);

          // Where to land is "is setting up finished?", not "is this password
          // temporary?". Routing on the password alone meant that after the
          // first step — which clears it — you were sent to an inbox while the
          // organisation was still unnamed, with nothing to take you back.
          //
          // `needsGithub` is deliberately not part of this. It is skippable,
          // and anyone who skipped it would be dragged back here on every
          // sign-in until they registered an application they may not want.
          try {
            const state = await setupState();
            router.replace(
              state.needsPassword || state.needsOrganization ? "/setup" : "/",
            );
          } catch {
            // If that call fails, the inbox is the safer guess: it renders its
            // own errors, where a wizard would be asking questions it cannot
            // save the answers to.
            router.replace("/");
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
          <span className="font-narrow text-[13px] font-semibold tracking-[0.22em] text-bone uppercase">
            Firetower
          </span>
        </div>

        <form onSubmit={submit} className="mt-8">
          <label className="block text-[12px] text-mute" htmlFor="username">
            Username
          </label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1.5 w-full rounded border border-line bg-transparent px-3 py-2 text-[13.5px] text-bone outline-none focus:border-ember"
          />

          <label className="mt-4 block text-[12px] text-mute" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 w-full rounded border border-line bg-transparent px-3 py-2 text-[13.5px] text-bone outline-none focus:border-ember"
          />

          {failed && (
            <p className="mt-3 text-[12.5px] text-ember" role="alert">
              {failed}
            </p>
          )}

          <button
            type="submit"
            disabled={login.isPending || !username || !password}
            className="mt-5 w-full rounded bg-ember px-3 py-2 text-[13px] font-medium text-ink disabled:opacity-40"
          >
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-[12px] leading-[1.6] text-mute">
          The first start prints a username and password in the log. If you have
          lost it, run{" "}
          <code className="font-mono text-[11.5px] text-slate">
            firetower passwd &lt;username&gt;
          </code>{" "}
          on the machine Firetower runs on.
        </p>
      </div>
    </div>
  );
}
