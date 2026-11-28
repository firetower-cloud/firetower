/**
 * Who you are on this server, and the ways out.
 *
 * `auth/me` is asked on every visit rather than trusted from the sign-in: the
 * stored user can be stale, and whether a password still has to be replaced is
 * a fact about the server, not about this client.
 *
 * **A password form in a tab, and none in the app.** The installed app sends
 * you to the control plane's own interface, which is one address it already
 * knows and is never a version behind the server, as an app can be. A page in
 * a tab *is* that interface, served by the same server, so sending it
 * elsewhere was sending somebody to where they already were. It carries the
 * form itself: current, new, again, as `web/components/Account.tsx` does.
 * The server answers a change with a fresh token and ends every other
 * session, this one included, so the token is swapped before anything else
 * can be refused (`updateToken`).
 *
 * What is left here is the two things that are about this client rather than
 * about the account: sign out revokes this client's token on the server, and
 * forget drops the server from it without asking the server anything — for
 * the day it is no longer reachable.
 *
 * **Forget is the installed app's alone.** It is half of being able to hold
 * several Firetowers at once, and a page served by one can only ever reach
 * that one — see `~/installed-app`. Sign out is everybody's.
 */
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, KeyRound, LogOut, Trash2 } from "lucide-react";
import { useChangePassword, useLogout, useMe } from "~/api/generated/auth/auth";
import { Button } from "~/components/ui";
import { useBackendKey, dropCache } from "~/backend";
import { installedApp } from "~/installed-app";
import { forget, servers, updateToken } from "~/servers";
import { navigate } from "~/shims/next-navigation";
import { openExternal } from "~/open";
import { passwordPage } from "~/ui/ReplacePassword";
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

  /* Dropping a Firetower is only meaningful where there can be another one.
     Read once: the password section and the sign-in row both ask it. */
  const canForget = installedApp();
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
              <b>This password has to be replaced before anything else here will work.</b>{" "}
              {canForget ? "Open the control plane below and choose your own." : "Choose your own below."}
            </p>
          </div>
        )}

        {/* **Where your own work is filed**, which came here with the
            deployment pane: it was a row on *This Firetower* beside the
            address and the account, and those are this screen's subject rather
            than the installation's. `slug` rather than the username, because
            the two can differ and only one of them appears in a path — see
            `User.slug`, which exists so a rename never moves anything. */}
        {user?.slug && (
          <p className="mt-4 text-ui text-dim">
            Your own work is filed at <span className="font-mono text-bone">u/{user.slug}</span>.
            Anything there is yours and is reachable by nobody else until you share it.
          </p>
        )}

        {/* The address this client reached the server on, which is the one proven
            to work from here — not a value the server reports about itself.

            **Through `passwordPage`, not the bare origin.** This is the second
            half of the defect `42b3bfad` fixed on the other screen and only
            there: serving the application at `/` took that path off the
            administration site, so this button opened the very app it was
            pressed in — a control that looks like a way out and is a way back
            to where you already are. There were exactly two screens that send
            somebody to this Firetower's own web interface, and the rule they
            both go through now lives in `ReplacePassword.tsx` beside the
            reasoning for it. `replace-password.test.ts` pins both.

            **The app's only.** In a tab this page is already the control
            plane's own interface, so the form is drawn here instead; see the
            top of this file. */}
        <section className="lsec">
          <h2>Password</h2>
          {canForget ? (
            <>
              <p className="note">
                Your account and your password are managed on the Firetower control plane — one address this app
                already knows, and never a version behind the server.
              </p>
              <div className="card1">
                <button onClick={() => void openExternal(passwordPage(origin))} className="btn plain">
                  Open {origin.replace(/^https?:\/\//, "")}
                  <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="note">Changing it signs every other browser and app out.</p>
              <NewPassword serverId={key} />
            </>
          )}
        </section>

        {/* **The way out, and nothing said around it.** It had a heading,
            a note about connections and an aside on what signing out
            revokes; the user asked for the buttons alone. Sign out still
            revokes this client's token on the server. */}
        <section className="lsec">
          <div className="card1 flex flex-wrap items-center gap-3">
            <button disabled={leave.isPending} onClick={() => leave.mutate(true)} className="btn plain"><LogOut className="h-3.5 w-3.5" strokeWidth={1.75} />Sign out</button>
            {/* **Brick, and it says Firetower.** It was dim and said "server",
                which is the one control on this screen that cannot be undone
                drawn as the quietest thing on it.

                **And it is the installed app's only.** Forgetting a Firetower
                is half of multi-installation switching — it drops the token
                here and leaves the server alone, so that a client pointed at
                several can stop being pointed at one. A served page is pointed
                at the Firetower that sent it and nothing else, so forgetting
                it would sign somebody out of the page they are reading and
                land them back on its own door. Sign out is the control that
                means that, and it is right there. See `~/installed-app`. */}
            {canForget && (
              <button
                disabled={leave.isPending}
                onClick={() =>
                  void confirm({
                    title: `Forget ${backend.org} here?`,
                    body: "The token is dropped here; the server is not told, and its sessions carry on.",
                    action: "Forget this Firetower",
                    tone: "danger",
                  }).then((ok) => ok && leave.mutate(false))
                }
                className="btn danger ml-auto"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />Forget this Firetower
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Current, new, again — the form `web/components/Account.tsx` carries, for a
 * page served by the control plane.
 *
 * **Drawn the way this app draws a form**, not the way the web site does:
 * `.form` of `.fld` labels over `.box` fields, as the profile editor and the
 * invite sheet have them, on the sheet rather than in a `.card1`. The fields
 * are `--color-ground` and a card is `--color-raise`, two greys apart by a
 * shade, which is why the first draft's boxes read as switched off. The
 * button and its message are the Name row's in Deployment: a plain `Button`,
 * and an `aside1` that turns brick only for something that failed.
 *
 * The length rule is the server's and so is its sentence: it is checked
 * there, and a second copy here would be a second number to keep in step.
 * Only the one thing the server cannot see is checked before asking — that
 * the two new ones agree.
 */
function NewPassword({ serverId }: { serverId: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  /* The swap is the hook's own `onSuccess`, which runs before anything the
     caller passes to `mutate`: the old token is dead the moment the server
     answered, and every request until this runs is refused. */
  const change = useChangePassword({ mutation: { onSuccess: ({ token }) => updateToken(serverId, token) } });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!current || !next || change.isPending) return;
    setDone(false);
    setTrouble(null);
    if (next !== again) return setTrouble("The two new passwords differ.");
    change.mutate(
      { data: { current, new: next } },
      {
        onSuccess: () => {
          setCurrent("");
          setNext("");
          setAgain("");
          setDone(true);
        },
        onError: (err) => setTrouble(why(err)),
      },
    );
  };

  const field = (label: string, value: string, set: (v: string) => void, autoComplete: string) => (
    <label className="fld">
      <span>{label}</span>
      <span className="box">
        <input type="password" value={value} onChange={(e) => set(e.target.value)} autoComplete={autoComplete} spellCheck={false} />
      </span>
    </label>
  );

  return (
    <form onSubmit={submit} className="form mt-[11px]">
      {field("Current password", current, setCurrent, "current-password")}
      {field("New password", next, setNext, "new-password")}
      {field("New password, again", again, setAgain, "new-password")}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!current || !next || !again || change.isPending}>
          {change.isPending ? "Changing…" : "Change password"}
        </Button>
        {trouble ? (
          <span role="alert" className="aside1 !text-brick">{trouble}</span>
        ) : (
          done && <span className="aside1">Password changed.</span>
        )}
      </div>
    </form>
  );
}
