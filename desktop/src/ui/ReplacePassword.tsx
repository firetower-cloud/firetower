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
              was set by an administrator, who has seen it. Choose your own in a browser, then come
              back here.
            </>
          )}
        </p>

        {held ? (
          /* Side by side: one way out and one way back, and neither is the
             length of the card — a full-width button reads as the only thing
             to do, and here there are two. */
          <div className="mt-5 flex items-center justify-center gap-2">
            <button onClick={() => void openExternal(origin)} className="btn primary">
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
            <button onClick={() => void openExternal(origin)} className="btn primary go">
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
            "Signing in there is also how you reach the rest of your organisation's settings."
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
