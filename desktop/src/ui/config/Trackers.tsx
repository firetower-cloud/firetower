/**
 * Where the tasks list reads from.
 *
 * **Its own pane now.** Trackers used to share one with the git hosts under
 * the word "Integrations", which made every git host appear twice on one
 * screen — once to connect, once here saying "connects above" — and pushed
 * this half off the bottom as hosts were added.
 *
 * Every git host is still a tracker: an issue is work to pick up and a request
 * to merge is work to review. They are derived from the hosts rather than
 * configured again, so there is nothing to connect here and the row says where
 * it is done. Linear is a tracker only, and takes a key of its own.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Unlink } from "lucide-react";
import { HostMark, Icon, LinearMark } from "~/components/ui";
import type { TrackerStatus } from "~/api/generated/model";
import {
  getListTrackersQueryKey,
  useDisconnectTracker,
  useListTrackerScopes,
  useSetTrackerKey,
} from "~/api/generated/trackers/trackers";
import { useTrackers, why } from "~/data";
import { Rows, Section } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";

export function Trackers({ live }: { live: boolean }) {
  const trackers = useTrackers();

  /**
   * Connected trackers first, as on the git hosts list.
   *
   * Every git host is a tracker, so this list is as long as that one and grows
   * with it — and the rows that answer "what can the tasks screen read" were
   * sorted below the rows that cannot. The server's order is the install's and
   * stays as it is on the wire; this sorts the drawing only, and stably, so
   * trackers in the same state keep that order between them.
   */
  const rows = useMemo(
    () => [...trackers.data].sort((a, b) => Number(b.connected) - Number(a.connected)),
    [trackers.data],
  );

  return (
    <Section
      title="Trackers"
      note="Where the tasks list reads from. Every git host is one. An API key can belong to a directory, so one key answers for a team."
    >
      <Rows feed={trackers} empty="No tracker is available on this server.">
        {rows.map((t) => (
          <Tracker key={t.id} t={t} live={live} />
        ))}
      </Rows>
    </Section>
  );
}

/**
 * What this tracker can return, in the words its own host uses.
 *
 * `t.kinds` is the wire enum — `issue`, `pullRequest`, `ticket` — and rendering
 * it put camelCase on screen and, on a GitLab, the wrong word entirely: a
 * GitLab has merge requests and no pull requests at all.
 */
function says(t: TrackerStatus): string {
  return t.kinds
    .map((k) =>
      k === "pullRequest" ? `${t.changeNoun}s` : k === "ticket" ? "tickets" : "issues",
    )
    .join(", ");
}

function Tracker({ t, live }: { t: TrackerStatus; live: boolean }) {
  const cache = useQueryClient();
  const set = useSetTrackerKey();
  const disconnect = useDisconnectTracker();
  const scopes = useListTrackerScopes(t.id, { query: { enabled: t.connected } });
  const [key, setKey] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: getListTrackersQueryKey() });
  const named = (scopes.data ?? []) as { name?: string; id?: string }[];

  return (
    <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-ui text-bone">
          {t.kind === "linear" ? (
            <LinearMark size={12} className="shrink-0 text-mute" />
          ) : (
            <HostMark kind={t.kind} size={12} className="shrink-0 text-mute" />
          )}
          {t.label}
        </span>
        <span className="block text-micro text-mute">
          {says(t)}
          {t.connected && named.length > 0 && ` · ${named.length} ${t.scopeKind}`}
          {account && ` · as ${account}`}
        </span>
      </span>
      {t.connected ? (
        <>
          <span className="flex items-center gap-1.5 text-meta text-sage"><Icon of={Check} size={12} />connected</span>
          {/* An API key is frequently the organisation's — one Linear workspace
              key a team shares, rather than five people pasting the same
              string. A git host's is not: its token pushes commits, and a
              commit has to be attributable to a person, so the server hands
              back no handle for one and nothing is drawn here. */}
          {t.secret && <WhoCanAccess look="chip" kind="secret" id={t.secret} path={t.path} />}
          {t.auth === "apiKey" && <button disabled={!live} onClick={() => disconnect.mutate({ id: t.id }, { onSuccess: refresh })} className="control text-mute hover:text-brick"><Icon of={Unlink} size={12} /></button>}
        </>
      ) : t.auth === "gitProvider" ? (
        /* Not "above" any more — the hosts are their own pane, and a row that
           points at a place on this screen that is no longer here is worse
           than one that names where to go. */
        <span className="text-meta text-mute">connects under Git hosts</span>
      ) : (
        <div className="flex items-center gap-1.5">
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="API key" className="w-44 rounded-md border border-line bg-ground px-2 py-1 font-mono text-micro text-bone focus:outline-none" />
          {t.keyUrl && <a href={t.keyUrl} target="_blank" rel="noreferrer" className="text-micro text-mute underline">get one</a>}
          <button disabled={!key.trim() || !live || set.isPending} onClick={() => set.mutate({ id: t.id, data: { key: key.trim() } }, { onSuccess: (c) => { setAccount(c.account); setKey(""); refresh(); } })} className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute">{set.isPending ? "Checking…" : "Connect"}</button>
          {set.error && <span className="text-meta text-brick">{why(set.error)}</span>}
        </div>
      )}
    </div>
  );
}
