/**
 * The one control that puts something in the library, wherever it is drawn.
 *
 * **It said two different things for one action.** A catalogue row said
 * *Connect* — because taking a copy and authorizing it is one intention —
 * and the detail screen for the same entry said *Add*, in a different shape,
 * a few pixels away. Two names for one button is how somebody concludes
 * there are two features and goes looking for the difference.
 *
 * So the states live here and nowhere else: adding, connecting, waiting on a
 * browser, needing an application by hand, done. A caller picks `where` it is
 * drawn and gets the same words either way.
 */
import { Check, Link2, Loader2, Plus } from "lucide-react";

/** What the button needs to know, from either screen's own shape. */
export type Taking = {
  /** Does it carry a server? Then the press authorizes as well as copies. */
  hasConnector?: boolean;
  /** Already in the library. */
  installed?: boolean;
  /** This person holds a credential for it. */
  connected?: boolean | null;
  /** It registers no OAuth clients, so an application has to be made once. */
  needsClientId?: boolean;
};

/** What the control has to say, which is a decision and not a rendering. */
export type Says = "busy" | "done" | "set-up" | "waiting" | "offer";

/**
 * **A fact outranks a guess, and this order is where that is said.**
 *
 * `waiting` means "a browser tab was opened and has not reported back" — an
 * inference drawn from what we did. `connected` is the control plane
 * answering that the credential is held. Asking the inference first left
 * Canva, authorized and recorded, spinning on "Waiting…" until a five-minute
 * timer gave up.
 *
 * Then `needsClientId`, because a server that hands out no clients will never
 * report one and must not sit on Connect for ever either.
 */
export function says(of: Taking, busy?: boolean, waiting?: boolean): Says {
  if (busy) return "busy";
  if (of.connected === true || (of.installed && !of.hasConnector)) return "done";
  if (of.installed && of.needsClientId) return "set-up";
  if (waiting) return "waiting";
  return "offer";
}

export function Take({
  of,
  busy,
  waiting,
  where = "row",
  onPress,
  onOpen,
}: {
  of: Taking;
  busy?: boolean;
  /** An authorization this control started is outstanding. */
  waiting?: boolean;
  /** `row` is quiet until the row is under the pointer; `page` always shows. */
  where?: "row" | "page";
  onPress: () => void;
  /** Where "Set it up" goes, since the form is on the detail screen. */
  onOpen?: () => void;
}) {
  const shape = where === "page" ? "act act-page" : "act";

  switch (says(of, busy, waiting)) {
    case "busy":
      return (
        <span className="act-said">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          {of.hasConnector ? "Connecting…" : "Adding…"}
        </span>
      );
    case "done":
      return (
        <span className="act-said act-done">
          <Check className="h-3.5 w-3.5" strokeWidth={2} />
          {of.hasConnector ? "Connected" : "Added"}
        </span>
      );
    case "set-up":
      return (
        <button type="button" className={shape} onClick={onOpen ?? onPress}>
          Set it up
        </button>
      );
    case "waiting":
      return (
        <span className="act-said" title="Finish in the browser; this updates itself.">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
          Waiting…
        </span>
      );
    default:
      return (
        <button type="button" className={shape} onClick={onPress}>
          {of.hasConnector ? (
            <>
              <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Connect
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              Add
            </>
          )}
        </button>
      );
  }
}
