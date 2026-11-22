/**
 * Deletions an agent asked for, waiting on a person.
 *
 * **There is no MCP tool that deletes.** `request_deletion` writes the
 * question down and stops; this is where it is answered, and the answering is
 * a REST call an agent cannot reach — its only door to the control plane is
 * the delegate tool dispatch, and approve is not on it. So an agent cannot
 * delete on its own as a property of the shape, not of a check.
 *
 * ## It is drawn on the screen that owns the object
 *
 * Not in a notifications pane. The question is "should this team go", and the
 * only place that can be answered honestly is the one listing the teams —
 * where the thing is in front of you, a click from being opened and read. A
 * tray somewhere else turns an irreversible decision into a card with a name
 * on it.
 *
 * ## What it says before you press
 *
 * `takes` is re-read by the server on every list, not replayed from the row:
 * the tree may have grown a branch since the agent asked, and the number
 * somebody approves has to be the number that happens.
 */
import { useState } from "react";
import { Trash2, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  approveDeletion,
  getListDeletionRequestsQueryKey,
  refuseDeletion,
  useListDeletionRequests,
} from "~/api/generated/deletions/deletions";
import { getListAgentTeamsQueryKey } from "~/api/generated/agent-teams/agent-teams";
import { getListRolesQueryKey } from "~/api/generated/roles/roles";
import { why } from "~/data";
import { Icon } from "~/components/ui";
import type { Kind, Waiting } from "~/api/generated/model";

/** The kind of thing a screen is showing, as the API names it. */
export function AskedToDelete({ of }: { of: Kind }) {
  const q = useListDeletionRequests();
  const waiting = (q.data ?? []).filter((r) => r.kind === of);
  if (waiting.length === 0) return null;
  return (
    <div className="asked">
      {waiting.map((r) => (
        <Asked key={r.id} r={r} />
      ))}
    </div>
  );
}

function Asked({ r }: { r: Waiting }) {
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();

  const settle = async () => {
    await cache.invalidateQueries({ queryKey: getListDeletionRequestsQueryKey() });
    await cache.invalidateQueries({ queryKey: getListAgentTeamsQueryKey() });
    await cache.invalidateQueries({ queryKey: getListRolesQueryKey() });
  };

  const yes = async () => {
    setBusy("yes");
    setTrouble(null);
    try {
      await approveDeletion(r.id);
      await settle();
    } catch (e) {
      setTrouble(why(e));
      setBusy(null);
    }
  };
  const no = async () => {
    setBusy("no");
    setTrouble(null);
    try {
      await refuseDeletion(r.id, { note: null });
      await settle();
    } catch (e) {
      setTrouble(why(e));
      setBusy(null);
    }
  };

  const noun = r.kind === "agentTeam" ? "team" : "profile";
  return (
    <div className="askrow" data-gone={r.gone}>
      <span className="g" aria-hidden>
        <Icon of={Trash2} size={16} />
      </span>
      <div className="say">
        <p>
          {/* **The agent asked. It did not do it.** Said in the first six
              words, because that is the thing a person has to know before
              they read anything else on this row. */}
          <b>An agent asked you to delete the {noun} “{r.targetName}”.</b> Nothing has happened.
        </p>
        {/* The agent's own words, marked as its own words. */}
        {r.reason && <p className="said">“{r.reason}”</p>}
        <p className="takes">{r.gone ? "It is not there any more." : r.takes}</p>
        {trouble && (
          <p className="bad">
            <Icon of={TriangleAlert} size={12} /> {trouble}
          </p>
        )}
      </div>
      <div className="acts">
        <button onClick={no} disabled={!!busy} className="btn quiet">
          {busy === "no" ? "…" : "Keep it"}
        </button>
        {/* `harm`, not `primary`. The destructive answer must not be the one
            the eye lands on as the obvious next step. */}
        <button onClick={yes} disabled={!!busy || r.gone} className="btn harm">
          {busy === "yes" ? "Deleting…" : `Delete the ${noun}`}
        </button>
      </div>
    </div>
  );
}
