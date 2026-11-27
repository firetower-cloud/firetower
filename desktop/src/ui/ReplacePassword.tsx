/**
 * A password that has to be replaced, which this app deliberately cannot do.
 *
 * Replacing a password happens once, under duress, and it happens on the
 * control plane's own interface. The app does not carry a second copy of that
 * form: two implementations of the screen that decides whether somebody can
 * get in at all is one more than anybody can keep correct, and the browser is
 * the surface that is always reachable and always the same version as the
 * server behind it.
 *
 * Reached two ways, which is why this is a component rather than part of the
 * sign-in screen. At the door, when the password just typed turns out to be a
 * temporary one. And mid-session, when an administrator resets a password
 * under a running app — every request then starts coming back refused, and
 * without this the app would be a wall of "could not reach the control plane"
 * for a server that is answering perfectly.
 *
 * It does not say "first sign-in". The same flag is raised by an administrator
 * resetting somebody's password years in, and a screen that tells a four-year
 * employee they are new is a screen they stop believing.
 *
 * **The address is the one that was typed to find this server**, not one the
 * server reports about itself. That is the address proven to work from this
 * machine, which is the only property a link somebody is about to click needs
 * to have.
 */
import { ExternalLink, KeyRound, RotateCw } from "lucide-react";
import { openExternal } from "~/open";

/**
 * Where a password is actually replaced, on the control plane's own interface.
 *
 * **This used to be the bare root and the root moved.** Serving the application
 * at `/` — the change that made it reachable in a browser at all — took that
 * path off the administration site, so this button opened the very app that had
 * just said it does not carry this screen, which drew the same gate again. A
 * closed loop, and in the shell as well as in a browser: there the button hands
 * the URL to the system browser, which lands on the same page.
 *
 * **It then pointed at `/login`, which is a door rather than a form.** That was
 * reasoned about the screen this function started on — the one below, reached
 * holding a temporary password — where signing in routes on `setupState()` and
 * a password still owed lands on `/setup`. True, and it covers exactly half of
 * the callers. `Account.tsx` goes through the same rule and is the voluntary
 * change: somebody signed in who simply wants a new password. `/login` sends
 * them back into the application when they sign in, because nothing is owed, so
 * that half never reached a form at all.
 *
 * `/account` is the form — current, new, again — and the only one in the
 * product: the renderer deliberately carries none, for the reason at the top of
 * this file. Both callers go there now, and the screen below still works: it
 * needs a session, and without one the administration site bounces to `/login`,
 * where signing in with a temporary password routes to `/setup` exactly as
 * before. One redirect longer, same destination.
 *
 * **The known gap, which is not this function's to close.** A browser with no
 * administration-site session that asks for `/account` is sent to `/login`, and
 * `/login` carries no way back — after signing in it goes to `/setup` if a
 * password is owed and to the application otherwise. So a *voluntary* change
 * started from a browser that has never signed in to the site still ends up in
 * the application rather than at the form. That is a missing return path on the
 * site, measured and reported rather than papered over here; `/account` is
 * strictly the better target either way, because it is the only one that can
 * ever be the form.
 */
export function passwordPage(origin: string): string {
  return `${origin}/account`;
}

export function ReplacePassword({
  url,
  username,
  retryLabel,
  onRetry,
  onBack,
  backLabel,
  held,
}: {
  /** The origin this Mac reached the Firetower on. */
  url: string;
  username?: string;
  retryLabel: string;
  onRetry: () => void;
  onBack?: () => void;
  backLabel?: string;
  /**
   * Held at the door of a server already connected, rather than met on the
   * way in.
   *
   * The drawing treats the two differently and is right to: the first is one
   * step of a flow and reads left-aligned like the steps either side of it;
   * the second is the whole window stopping, and it is centred, quieter, and
   * says what is *still* true — your workspaces are running, your account is
   * reachable — because the person reading it is stuck rather than arriving.
   */
  held?: boolean;
}) {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }
  const host = origin.replace(/^https?:\/\//, "");

  return (
    <div className="first">
      <div className={`card ${held ? "text-center" : ""}`}>
        {/* **Not ember.** Ember means an agent is waiting on you. A password
            that has to be replaced is a door. */}
        <span className={`mk ${held ? "mx-auto !bg-raise !text-dim" : ""}`}>
          <KeyRound className="h-6 w-6" strokeWidth={1.75} />
        </span>
        <h1>{held ? "Your password has to be replaced" : "Replace this password"}</h1>
        <p>
          {held ? (
            <>
              An administrator reset it. Every request is coming back refused until a new one is
              chosen, and choosing one happens on the control plane&apos;s own interface — this app
              deliberately does not carry a second copy of the screen that decides whether anybody
              can get in.
            </>
          ) : (
            <>
              {username ? <><span className="text-text">{username}</span>&apos;s password </> : "Your password "}
              was set by an administrator, who has seen it. Choose your own on the control plane,
              then sign in with it.
            </>
          )}
        </p>

        {held ? (
          /* Side by side: one way out and one way back, and neither is the
             length of the card — a full-width button reads as the only thing
             to do, and here there are two. */
          <div className="mt-5 flex items-center justify-center gap-2">
            <button onClick={() => void openExternal(passwordPage(origin))} className="btn primary">
              Open {host}
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <button onClick={onRetry} className="btn quiet">
              <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              {retryLabel}
            </button>
          </div>
        ) : (
          <>
            <button onClick={() => void openExternal(passwordPage(origin))} className="btn primary go">
              Open {host}
            </button>
            <button onClick={onRetry} className="btn plain go !mt-2.5">
              {retryLabel}
            </button>
          </>
        )}

        <p className="alt">
          {held ? (
            <>
              Your workspaces are untouched and the agents in them are still running.{" "}
              <b className="font-medium text-text">Account stays reachable from here</b>, because
              signing out and forgetting this Firetower are both legitimate answers to being stuck.
            </>
          ) : (
            /* **It used to send you to the web for the organisation**, and
               People, Teams and Directories are in this app now — so the
               sentence named a place that is no longer where any of it
               happens. What is still true, and is what somebody stuck on this
               screen wants to know, is that nothing of theirs is waiting on
               the password being replaced. */
            "Everything of yours stays exactly where it is while you do."
          )}
        </p>

        {onBack && (
          <button onClick={onBack} className="btn quiet mx-auto mt-4 block">
            {backLabel ?? "Back"}
          </button>
        )}
      </div>
    </div>
  );
}
