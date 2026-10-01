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
import { ExternalLink, KeyRound, LogOut, Trash2 } from "lucide-react";
import { useLogout, useMe } from "~/api/generated/auth/auth";
import { useBackendKey, dropCache } from "~/backend";
import { forget, servers } from "~/servers";
import { navigate } from "~/shims/next-navigation";
import { openExternal } from "~/open";
import type { Backend } from "~/fleet";

import { why } from "~/data";
import { useConfirm } from "~/ui/Confirm";

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

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[40rem] px-6 py-6 pb-16">
        <h1 className="text-display text-bone">{user?.username ?? backend.user}</h1>
        <p className="mt-2 text-read text-dim">
          {user?.role ?? "member"} at <span className="text-text">{org?.name ?? backend.org}</span>
          {stored && <span className="text-mute"> · {stored.url.replace(/^https?:\/\//, "")}</span>}
        </p>
        {me.error ? <p className="mt-2 text-meta text-brick">{why(me.error)}</p> : null}

        {user?.mustChangePassword && (
          <p className="mt-4 rounded-xl border border-ember-deep bg-ember-tint px-4 py-3 text-ui text-bone">
            This password has to be replaced before anything else here will work. Open the control plane below and choose your own.
          </p>
        )}

        {/* The address this Mac reached the server on, which is the one proven
            to work from here — not a value the server reports about itself. */}
        <section className="mt-7">
          <h2 className="flex items-center gap-2 text-title text-bone"><KeyRound className="h-4 w-4 text-dim" strokeWidth={1.75} />Password</h2>
          <p className="mt-0.5 text-meta text-mute">To manage your account and password open the Firetower control plane</p>
          <div className="mt-2.5 rounded-xl border border-line bg-panel p-4">
            <button
              onClick={() => void openExternal(origin)}
              className="control border border-line bg-raise text-bone hover:bg-overlay"
            >
              Open {origin.replace(/^https?:\/\//, "")}
              <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
            </button>
          </div>
        </section>

        <section className="mt-7">
          <h2 className="text-title text-bone">This Mac</h2>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-4">
            <button disabled={leave.isPending} onClick={() => leave.mutate(true)} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"><LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />Sign out</button>
            <span className="text-meta text-mute">revokes this Mac's token on the server</span>
            <button disabled={leave.isPending} onClick={() => void confirm({ title: `Forget ${backend.org} on this Mac?`, body: "The token is dropped here; the server is not told, and its sessions carry on.", action: "Forget this server", tone: "danger" }).then((ok) => ok && leave.mutate(false))} className="control ml-auto text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Forget this server</button>
          </div>
        </section>
      </div>
    </div>
  );
}
