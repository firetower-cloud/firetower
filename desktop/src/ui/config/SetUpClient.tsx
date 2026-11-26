/**
 * Supplying the OAuth application a server will not hand out itself.
 *
 * **It lives where Connect is pressed.** This used to exist only inside the
 * detail screen, so a server that needed an application answered Connect with
 * a sentence telling somebody to open the details and press a second button —
 * three screens to reach a form we already knew they needed, and an error
 * message standing in for a control. Nineteen of the catalogue's entries hit
 * that, including all eight Google ones.
 *
 * So it is a component, and the row opens it in a modal. The detail screen
 * shows the same thing in place, because there is no navigation to do when
 * you are already there.
 */
import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { why } from "~/data";
import { openExternal } from "~/open";
import { setClient, useConnectorState } from "~/api/generated/connectors/connectors";

export type NeedsClient = {
  skillId: string;
  displayName: string;
  /**
   * Where to go to come back with a client id, as many links as the vendor's
   * setup takes, each named by the entry.
   *
   * **The labels are theirs.** This was a `console` and a `guide`, which is
   * how Google splits the job — so every other vendor was described in
   * Google's words, and a button said "Console" at somebody whose vendor
   * calls it a developer portal.
   */
  setup?: { label: string; url: string }[];
};

export function SetUpClient({
  of,
  onDone,
  onCancel,
}: {
  of: NeedsClient;
  /** Saved; the caller authorizes and refreshes. */
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const state = useConnectorState(of.skillId, { query: { select: (r) => r } }).data;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setBad(null);
    try {
      await setClient(of.skillId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || null,
      });
      setClientSecret("");
      await onDone();
    } catch (e) {
      setBad(why(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="max-w-[74ch] text-meta text-dim">
        {of.displayName} does not register clients itself, so somebody creates one in its
        console and pastes it here — once, for everybody on this Firetower. Each person
        still authorizes their own account.
      </p>

      {/* **However many pages the vendor's setup takes.** Google's is a
          console and a twelve-step guide; Twilio's is one page; somebody
          else's might be three. The entry says how many and what they are
          called, because naming another company's pages is not ours to do. */}
      {(of.setup?.length ?? 0) > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {of.setup!.map((l) => (
            <button
              key={l.url}
              type="button"
              className="out"
              onClick={() => void openExternal(l.url)}
            >
              <ExternalLink className="h-4 w-4" strokeWidth={1.5} />
              {l.label}
            </button>
          ))}
        </div>
      )}

      <p className="mt-4 text-meta text-dim">Its redirect address has to be exactly this:</p>
      <p className="mt-1 select-all break-all rounded-lg bg-sunk px-3 py-2 font-mono text-meta text-bone">
        {state?.redirectUri ?? "…"}
      </p>

      {/* The consent screen has to carry these, or the authorization is
          refused over a scope nobody configured. */}
      {state?.scopes && (
        <>
          <p className="mt-3 text-meta text-dim">
            Its consent screen needs these scopes, and no others are asked for:
          </p>
          <ul className="mt-1 select-all rounded-lg bg-sunk px-3 py-2 font-mono text-meta text-text">
            {state.scopes.split(" ").map((s) => (
              <li key={s} className="break-all">
                {s}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-4 flex flex-col gap-2">
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID"
          aria-label="Client ID"
          autoFocus
          className="rounded-lg bg-panel px-3 py-2 font-mono text-ui text-bone outline-none placeholder:text-mute"
        />
        <input
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          type="password"
          placeholder="Client secret — leave empty if it has none"
          aria-label="Client secret"
          onKeyDown={(e) => {
            if (e.key === "Enter" && clientId.trim() && !busy) void save();
          }}
          className="rounded-lg bg-panel px-3 py-2 font-mono text-ui text-bone outline-none placeholder:text-mute"
        />
      </div>

      {bad && <p className="mt-3 text-meta text-brick">{bad}</p>}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn primary"
          disabled={busy || !clientId.trim()}
          onClick={() => void save()}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />}
          Save and connect
        </button>
        <button type="button" className="btn quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

/**
 * The same form, over whatever somebody was looking at.
 *
 * Opened from a row, where there is no detail screen in the way.
 */
export function SetUpClientModal({
  of,
  onDone,
  onCancel,
}: {
  of: NeedsClient;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-scrim pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={onCancel}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        role="dialog"
        aria-modal
        aria-label={`An application for ${of.displayName}`}
        className="dlg max-h-[76vh] w-[min(620px,92vw)] overflow-y-auto p-5"
      >
        <h3 className="text-ui text-bone">An application for {of.displayName}</h3>
        <div className="mt-1">
          <SetUpClient of={of} onDone={onDone} onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}
