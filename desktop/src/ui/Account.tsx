/**
 * Who you are on this server, and the ways out.
 *
 * `auth/me` is asked on every visit rather than trusted from the sign-in —
 * the stored user can be stale, and the must-change-password gate is a fact
 * about the server, not the client. Changing the password answers with a new
 * token (`Rotated`), which replaces the stored one: everywhere else signed in
 * as you is signed out, which is the point. Sign out revokes the token on the
 * server; forget drops the server from this Mac without asking the server
 * anything, for the day it is no longer reachable.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, LogOut, Trash2 } from "lucide-react";
import { useChangePassword, useLogout, useMe } from "@/src/api/generated/auth/auth";
import { useBackendKey, dropCache } from "~/backend";
import { forget, servers, updateToken } from "~/servers";
import { navigate } from "~/shims/next-navigation";
import type { Backend } from "~/fleet";

import { why } from "~/data";

export function Account({ backend, onForgot }: { backend: Backend; onForgot: () => void }) {
  const key = useBackendKey();
  const me = useMe();
  const logout = useLogout();
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [rotated, setRotated] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  const leave = useMutation({
    mutationFn: async (revoke: boolean) => {
      if (revoke) await logout.mutateAsync(undefined as never).catch(() => {});
      forget(key);
      dropCache(key);
    },
    onSuccess: onForgot,
  });

  const rotate = () => {
    setTrouble(null);
    if (next !== again) return setTrouble("The two new passwords differ.");
    change.mutate(
      { data: { current, new: next } },
      {
        onSuccess: (r) => {
          updateToken(key, r.token);
          setRotated(true);
          setCurrent(""); setNext(""); setAgain("");
          me.refetch();
        },
        onError: (e) => setTrouble(why(e)),
      },
    );
  };

  const user = me.data?.user;
  const org = me.data?.organization;
  const stored = servers().find((s) => s.serverId === key);

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
            Your password came from a file. Replace it below before doing anything else — until then the file is the real credential.
          </p>
        )}

        <section className="mt-7">
          <h2 className="flex items-center gap-2 text-title text-bone"><KeyRound className="h-4 w-4 text-dim" strokeWidth={1.75} />Password</h2>
          <p className="mt-0.5 text-meta text-mute">Everywhere else signed in as you is signed out.</p>
          <div className="mt-2.5 space-y-2 rounded-xl border border-line bg-panel p-4">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" autoComplete="current-password" className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password" autoComplete="new-password" className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
            <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} onKeyDown={(e) => e.key === "Enter" && rotate()} placeholder="Again" autoComplete="new-password" className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
            {trouble && <p className="text-meta text-brick">{trouble}</p>}
            {rotated && <p className="text-meta text-sage">Changed. This Mac carries the new token.</p>}
            <button disabled={!current || !next || change.isPending} onClick={rotate} className="control bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{change.isPending ? "Changing…" : "Change it"}</button>
          </div>
        </section>

        <section className="mt-7">
          <h2 className="text-title text-bone">This Mac</h2>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-4">
            <button disabled={leave.isPending} onClick={() => leave.mutate(true)} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"><LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />Sign out</button>
            <span className="text-meta text-mute">revokes this Mac's token on the server</span>
            <button disabled={leave.isPending} onClick={() => { if (window.confirm(`Forget ${backend.org} on this Mac? The token is dropped here; the server is not told.`)) leave.mutate(false); }} className="control ml-auto text-mute hover:text-brick"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Forget this server</button>
          </div>
        </section>
      </div>
    </div>
  );
}
