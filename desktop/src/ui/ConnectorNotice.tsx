/**
 * What a session says when one of its connectors cannot be used.
 *
 * **The whole point is what this replaces.** A token that expires mid-session
 * fails silently today: the connector reported `connected` when the session
 * launched, the stale header goes out on every call, and the agent tells the
 * person to run `/mcp` — in a session that has no prompt to run it in. So the
 * control plane knows the grant has lapsed and says so *here*, beside the
 * input, with the way out as a button rather than as an instruction nobody can
 * follow.
 *
 * Two states, and they are different jobs. **Not signed in** is a connector
 * that is on for this session and was never sent to the agent, so nothing has
 * gone wrong yet — it is a thing to finish. **Expired** is a sign-in that
 * worked and has stopped, which is the one worth the louder treatment.
 *
 * Above the input and only when there is something to deal with, which is
 * `AccountNotice`'s rule — the two sit in the same place for the same reason.
 */
import { AlertTriangle, Plug } from "lucide-react";
import { navigate } from "~/shims/next-navigation";
import { useSessionConnectorIds } from "~/data";

export function ConnectorNotice({ sessionId }: { sessionId: string }) {
  const live = useSessionConnectorIds(sessionId);
  const trouble = live.trouble;
  if (trouble.length === 0) return null;

  const expired = trouble.filter((t) => t.reason === "Expired");
  const missing = trouble.filter((t) => t.reason === "NotSignedIn");
  const open = (id: string) => navigate(`/configuration/connectors/${id}`);

  return (
    <div
      className={`mb-2 rounded-xl border px-4 py-3 ${
        expired.length > 0 ? "border-kind-data/40 bg-panel" : "border-line-soft bg-panel/60"
      }`}
    >
      {expired.length > 0 && (
        <>
          <p className="flex items-start gap-2.5 text-ui text-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-kind-data" strokeWidth={1.75} />
            <span>
              Your sign-in to{" "}
              <span className="text-bone">{expired.map((t) => t.name).join(", ")}</span>{" "}
              {expired.length === 1 ? "has" : "have"} expired
              {expired[0]?.expiresAt
                ? ` — ${new Date(expired[0].expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })}`
                : ""}
              . {expired.length === 1 ? "It is" : "They are"} still on for this session and will
              fail on the next call.
            </span>
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-ui">
            <button
              onClick={() => open(expired[0]!.connectorId)}
              className="control bg-bone font-medium text-ground hover:opacity-90"
            >
              Sign in to {expired[0]!.name} again
            </button>
            <span className="text-meta text-mute">
              The agent picks it up when it next starts. Nothing else needs doing.
            </span>
          </div>
        </>
      )}

      {missing.length > 0 && (
        <p
          className={`flex items-start gap-2.5 text-meta text-mute ${expired.length > 0 ? "mt-2.5" : ""}`}
        >
          <Plug className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>
            <span className="text-dim">{missing.map((t) => t.name).join(", ")}</span>{" "}
            {missing.length === 1 ? "is" : "are"} on for this session and you have not signed in, so{" "}
            {missing.length === 1 ? "it was" : "they were"} not sent to the agent.{" "}
            <button
              onClick={() => open(missing[0]!.connectorId)}
              className="text-bone underline decoration-line underline-offset-2"
            >
              Sign in
            </button>
          </span>
        </p>
      )}
    </div>
  );
}
