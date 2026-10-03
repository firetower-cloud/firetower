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
import { KeyRound } from "lucide-react";
import { openExternal } from "~/open";

export function ReplacePassword({
  url,
  username,
  retryLabel,
  onRetry,
  onBack,
  backLabel,
}: {
  /** The origin this Mac reached the Firetower on. */
  url: string;
  username?: string;
  retryLabel: string;
  onRetry: () => void;
  onBack?: () => void;
  backLabel?: string;
}) {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = url;
  }
  const host = origin.replace(/^https?:\/\//, "");

  return (
    <div className="grid h-full min-w-0 flex-1 place-items-center bg-ground px-6">
      <div className="w-full max-w-[26rem]">
        <div className="text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-ember-deep bg-ember-tint text-ember">
            <KeyRound className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <h1 className="mt-4 text-display text-bone">Replace your password first</h1>
          <p className="mt-2 text-read text-dim">
            {username ? <><span className="text-text">{username}</span>&apos;s password </> : "Your password "}
            was set by an administrator, who has seen it. Choose your own in a browser, then come
            back here.
          </p>
        </div>

        <button
          onClick={() => void openExternal(origin)}
          className="control mt-5 w-full justify-center bg-bone font-medium text-ground transition-opacity hover:opacity-90"
        >
          Open {host}
        </button>

        <button
          onClick={onRetry}
          className="control mt-2 w-full justify-center border border-line bg-raise text-text hover:bg-overlay"
        >
          {retryLabel}
        </button>

        <p className="mt-4 text-center text-meta text-mute">
          Signing in there is also how you reach the rest of your organisation&apos;s settings.
        </p>

        {onBack && (
          <button
            onClick={onBack}
            className="mx-auto mt-5 block text-meta text-mute transition-colors hover:text-dim"
          >
            {backLabel ?? "Back"}
          </button>
        )}
      </div>
    </div>
  );
}
