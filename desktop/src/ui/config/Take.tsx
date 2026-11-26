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

  if (busy) {
    return (
      <span className="act-said">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
        {of.hasConnector ? "Connecting…" : "Adding…"}
      </span>
    );
  }
  // Before "connected", because a server that cannot hand out a client is
  // never going to report one and would otherwise sit on Connect for ever.
  if (of.installed && of.needsClientId && of.connected !== true) {
    return (
      <button type="button" className={shape} onClick={onOpen ?? onPress}>
        Set it up
      </button>
    );
  }
  if (waiting) {
    return (
      <span className="act-said" title="Finish in the browser; this updates itself.">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
        Waiting…
      </span>
    );
  }
  if (of.connected === true || (of.installed && !of.hasConnector)) {
    return (
      <span className="act-said act-done">
        <Check className="h-3.5 w-3.5" strokeWidth={2} />
        {of.hasConnector ? "Connected" : "Added"}
      </span>
    );
  }
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
