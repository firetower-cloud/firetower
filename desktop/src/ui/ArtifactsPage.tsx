/**
 * Every artifact you have published.
 *
 * This screen is the reason an artifact is owned by a person rather than by a
 * workspace. `reclaim.rs` deletes a workspace within a minute of its last
 * session ending and the cascade takes the conversation with it — so a list
 * that spans conversations can only exist if the rows deliberately sit outside
 * that cascade. They do: `artifacts` has foreign keys to `users` and
 * `organizations` and to nothing else.
 *
 * A list rather than a wall of cards. `STYLE.md` spends its density budget on
 * rows, and names "a rounded card around everything" as one of the three
 * habits that make an interface look generated. The thumbnail earns its place
 * because an artifact is a thing you recognise by sight; it does not earn a
 * 300px tile.
 */
import { useEffect, useState } from "react";
import { Shapes } from "lucide-react";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import type { Artifact } from "~/api/generated/model";
import { elapsed, minutesSince } from "~/api/view";
import { ArtifactTab } from "~/ui/ArtifactTab";
import { why } from "~/data";

/** Which of the three lists is showing. */
type Scope = "all" | "mine" | "shared";

export function ArtifactsPage() {
  const { data, isPending, error } = useListArtifacts({ query: { refetchInterval: 5000 } });
  const everything = data ?? [];
  const [scope, setScope] = useState<Scope>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  /* `mine` is decided by the server from the path — filed at your own root
     rather than in a directory — so the two lists cannot disagree with what
     `filed_where` let through in the first place. */
  const artifacts = everything.filter((a) =>
    scope === "all" ? true : scope === "mine" ? a.mine : !a.mine,
  );
  const shared = everything.filter((a) => !a.mine).length;

  /* Open the newest on arrival, so the screen is never an empty right half. */
  useEffect(() => {
    if (!picked && artifacts.length > 0) setPicked(artifacts[0].id);
  }, [artifacts, picked]);

  const showing = artifacts.find((a) => a.id === picked) ?? null;

  if (isPending) return <Empty>Looking…</Empty>;
  if (error) return <Empty>{why(error) ?? "Could not read your artifacts."}</Empty>;
  if (everything.length === 0)
    return (
      <Empty>
        Nothing published yet. Ask an agent to show you something — a mock-up, a page, a chart — and
        it appears here.
      </Empty>
    );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[22rem] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <Shapes className="h-3.5 w-3.5 text-mute" strokeWidth={1.75} />
          <span className="text-meta text-dim">Artifacts</span>
          <span className="ml-auto font-mono text-micro text-mute">{everything.length}</span>
        </div>

        {/* Offered only once there is a second list to go to. A "Shared with
            you" tab that is always empty teaches people the feature does not
            work. */}
        {shared > 0 && (
          <div className="shrink-0 border-b border-line px-2 py-1.5">
            <div className="track w-full">
              {(
                [
                  ["all", "All"],
                  ["mine", "Yours"],
                  ["shared", "Shared"],
                ] as [Scope, string][]
              ).map(([id, label]) => (
                <button key={id} data-on={scope === id} onClick={() => setScope(id)} className="flex-1">
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-1.5">
          {artifacts.length === 0 ? (
            <p className="px-4 py-8 text-center text-meta text-mute">
              {scope === "shared"
                ? "Nothing filed into a directory. Move one with the share control to let a team reach it."
                : "Nothing at your own root."}
            </p>
          ) : (
            artifacts.map((a) => (
              <Row key={a.id} artifact={a} on={a.id === picked} onPick={() => setPicked(a.id)} />
            ))
          )}
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1">
        {showing && (
          <ArtifactTab
            key={showing.id}
            artifact={showing}
            sessionId={showing.fromSessionId ?? null}
            expanded={expanded}
            onExpanded={setExpanded}
          />
        )}
      </div>
    </div>
  );
}

function Row({ artifact, on, onPick }: { artifact: Artifact; on: boolean; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${
        on ? "bg-overlay" : "hover:bg-raise/60"
      }`}
    >
      {/* The artifact itself, scaled. No screenshot service and no headless
          browser: the client already has a frame that can render it. */}
      <span className="relative block h-[48px] w-[84px] shrink-0 overflow-hidden rounded-sm border border-line bg-white">
        <iframe
          src={artifact.url}
          title=""
          tabIndex={-1}
          aria-hidden
          style={{ width: 1180, height: 674, transform: "scale(0.0712)", transformOrigin: "0 0" }}
          className="pointer-events-none absolute inset-0 border-0"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-ui ${on ? "text-bone" : "text-text"}`}>
          {artifact.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-micro text-mute">
          <span className="font-mono">v{artifact.version}</span>
          <span>·</span>
          {/* For a shared one the directory is the useful fact — whose
              workspace it came out of is not something the reader can reach. */}
          <span className="truncate">
            {artifact.mine
              ? (artifact.fromWorkspaceName ?? "no workspace")
              : (artifact.path?.split("/")[1] ?? "shared")}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-micro text-mute">
        {elapsed(minutesSince(artifact.updatedAt))}
      </span>
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center">
      <p className="max-w-[32ch] text-center text-meta text-mute">{children}</p>
    </div>
  );
}
