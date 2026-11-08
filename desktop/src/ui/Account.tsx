/**
 * Who you are on this server, and the ways out.
 *
 * `auth/me` is asked on every visit rather than trusted from the sign-in: the
 * stored user can be stale, and whether a password still has to be replaced is
 * a fact about the server, not about this Mac.
 *
 * **No password form.** Passwords are replaced on the control plane's own
 * interface, which is one address this app already knows and is never a
 * version behind the server. What is left here is the two things that are
 * about this Mac rather than about the account: sign out revokes this Mac's
 * token on the server, and forget drops the server from this Mac without
 * asking the server anything — for the day it is no longer reachable.
 */
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, KeyRound, LogOut, Trash2, UsersRound } from "lucide-react";
import { useLogout, useMe } from "~/api/generated/auth/auth";
import { useBackendKey, dropCache } from "~/backend";
import { forget, servers } from "~/servers";
import { navigate } from "~/shims/next-navigation";
import { openExternal } from "~/open";
import type { Backend } from "~/fleet";

import { why } from "~/data";
import { useConfirm } from "~/ui/Confirm";
import { WhereTo } from "~/ui/config/bits";

export function Account({ backend, onForgot }: { backend: Backend; onForgot: () => void }) {
  const confirm = useConfirm();
  const key = useBackendKey();
  const me = useMe();
  const logout = useLogout();

  const leave = useMutation({
    mutationFn: async (revoke: boolean) => {
      if (revoke) await logout.mutateAsync(undefined as never).catch(() => {});
      forget(key);
      dropCache(key);
    },
    onSuccess: onForgot,
  });

  const user = me.data?.user;
  const org = me.data?.organization;
  const stored = servers().find((s) => s.serverId === key);
  // Parsed before it is offered: a URL written by an older build, or edited by
  // hand in `localStorage`, should not produce a button that goes nowhere.
  let origin = backend.url;
  try {
    origin = new URL(backend.url).origin;
  } catch {
    /* keep it as stored; the button is still better than no way out */
  }

  /** The one-letter monogram, from whatever name there is. */
  const mark = (user?.username ?? backend.user ?? "?")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="pg" style={{ maxWidth: "640px" }}>
        {/* **A face beside the name.** The drawing opens this screen with a
            monogram, which is the one place in the app where the person
            looking is the subject rather than the operator. */}
        <div className="pg-head" style={{ alignItems: "flex-start" }}>
          <div className="flex min-w-0 items-center gap-[14px]">
            <span className="face2">{mark}</span>
            <div className="min-w-0">
              <h1 className="text-[1.75rem] leading-tight font-medium tracking-tight text-bone">{user?.username ?? backend.user}</h1>
              <p className="mt-[3px] text-read text-dim">
                {user?.role ?? "member"} at <span className="font-medium text-bone">{org?.name ?? backend.org}</span>
                {stored && <span className="text-mute"> · {stored.url.replace(/^https?:\/\//, "")}</span>}
              </p>
            </div>
          </div>
        </div>
        {me.error ? <p className="mt-2 text-meta text-brick">{why(me.error)}</p> : null}

        {/* Amber, not ember. **Ember means an agent is waiting on you and
            nothing else**, and a password that has to be replaced is not that
            — it is the other thing amber exists for, "you can carry on, but
            not for long". This read as ember for as long as there has been an
            Account screen. */}
        {user?.mustChangePassword && (
          <div className="warnbar">
            <span className="g"><KeyRound className="h-4 w-4" strokeWidth={1.75} /></span>
            <p>
              <b>This password has to be replaced before anything else here will work.</b> Open the control
              plane below and choose your own.
            </p>
          </div>
        )}

        {/* The address this Mac reached the server on, which is the one proven
            to work from here — not a value the server reports about itself. */}
        <section className="lsec">
          <h2>Password</h2>
          <p className="note">
            Your account and your password are managed on the Firetower control plane — one address this app
            already knows, and never a version behind the server.
          </p>
          <div className="card1">
            <button onClick={() => void openExternal(origin)} className="btn plain">
              Open {origin.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
            </button>
          </div>
        </section>

        <section className="lsec">
          <h2>This Mac</h2>
          <p className="note">
            Both of these are about this Mac rather than about your account. Neither touches anything running
            on the server.
          </p>
          <div className="card1 flex flex-wrap items-center gap-3">
            <button disabled={leave.isPending} onClick={() => leave.mutate(true)} className="btn plain"><LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />Sign out</button>
            <span className="aside1">revokes this Mac&rsquo;s token on the server</span>
            {/* **Brick, and it says Firetower.** It was dim and said "server",
                which is the one control on this screen that cannot be undone
                drawn as the quietest thing on it. */}
            <button
              disabled={leave.isPending}
              onClick={() =>
                void confirm({
                  title: `Forget ${backend.org} on this Mac?`,
                  body: "The token is dropped here; the server is not told, and its sessions carry on.",
                  action: "Forget this Firetower",
                  tone: "danger",
                }).then((ok) => ok && leave.mutate(false))
              }
              className="btn danger ml-auto"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Forget this Firetower
            </button>
          </div>
        </section>

        {/* Where the rest of it is. Everything an administrator does to an
            account happens somewhere else, and a screen that does not say so
            is a screen people hunt around in. */}
        <WhereTo className="mt-[22px]" icon={<UsersRound className="h-4 w-4" strokeWidth={1.75} />}>
          Everything else about an account — inviting somebody, changing a role, disabling or deleting —
          belongs to the administration site and is never drawn here. See <b>Settings &rarr; People</b>.
        </WhereTo>
      </div>
    </div>
  );
}
