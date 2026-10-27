/**
 * An artifact, in a tab of its own.
 *
 * Deliberately *not* `PreviewTab`. A preview is an application you navigate —
 * back, forward, an address bar, three viewport widths — because the thing
 * you are looking at has pages. An artifact is one document, and all of that
 * chrome is width taken away from the only thing on screen.
 *
 * So: the title, the version, and Expand. The notes list lives behind a count
 * rather than a permanent rail, because the rail is what made the preview feel
 * cramped and a document is mostly reading.
 *
 * **Expand is the point.** The complaint this whole feature answers is that
 * reading comfortably meant opening a browser tab, and the picker the control
 * plane injects refuses to run when `window.parent === window` — so the
 * browser is exactly where annotating stops working. Expanding inside the app
 * keeps the frame a frame, so Annotate goes on working at full width.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, CornerUpRight, Download, ExternalLink, Link2, Maximize2, Minimize2, Send, Share2, Trash2 } from "lucide-react";
import type { Artifact } from "~/api/generated/model";
import { sendTurn } from "~/api/generated/sessions/sessions";
import { renameArtifact } from "~/api/generated/artifacts/artifacts";
import { useQueryClient } from "@tanstack/react-query";
import { getListArtifactsQueryKey } from "~/api/generated/artifacts/artifacts";
import { openExternal } from "~/open";
import { bridge as shell } from "~/bridge";
import { apiBase, token } from "~/client/http";
import { why } from "~/data";
import { Annotate, type Anchor } from "~/ui/Annotate";
import { ContextMenu, useMenu, type MenuItem } from "~/ui/ContextMenu";
import { useSessions } from "~/data";
import { noteTarget } from "~/artifacts/target";
import { anchorIn } from "~/preview/anchor";
import { usePickerBridge, type Found, type Selection } from "~/preview/bridge";
import { FindBar } from "~/ui/FindBar";
import { WhoCanAccess } from "~/ui/Sharing";

/** What an element is, for a person: its tag and a little of its text. */
function nameOf(label: string, html: string): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text ? `<${label}> ${text.length > 40 ? `${text.slice(0, 40)}…` : text}` : `<${label}>`;
}

/** Where this app is, as an origin the picker will accept. */
const self = () =>
  location.origin && location.origin !== "null" ? location.origin : `${location.protocol}//${location.host}`;

type Note = { id: string; what: string; html: string; text: string; sent: boolean };

export function ArtifactTab({
  artifact,
  sendTo,
  expanded,
  onExpanded,
}: {
  artifact: Artifact;
  /**
   * Where notes go, when opening the artifact already settled that.
   *
   * A workspace's own agent, when the artifact was opened inside one: you are
   * looking at a conversation, and that is plainly who a note is for.
   *
   * `null` means it was opened from the library, where there is no
   * conversation in view and the right answer cannot be guessed — so one is
   * chosen below. **Not `fromSessionId`**, which is what this used to be
   * given: that column is stamped text rather than a foreign key, precisely so
   * it survives `reclaim.rs` taking the workspace. It therefore keeps naming a
   * session that no longer exists, the send button stayed enabled because the
   * id was not null, and the turn 404'd.
   */
  sendTo: string | null;
  expanded: boolean;
  onExpanded: (v: boolean) => void;
}) {
  const origin = useMemo(() => (artifact.url ? new URL(artifact.url).origin : null), [artifact.url]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  const [drafting, setDrafting] = useState<(Anchor & Selection) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [saving, setSaving] = useState(false);
  /* `null` when the title is just a title. A string while it is being typed —
     including the empty string, which is why this is not `naming || title`. */
  const [naming, setNaming] = useState<string | null>(null);
  const cache = useQueryClient();

  /* **Who a note goes to.**
     Fixed when the artifact was opened inside a workspace. Otherwise chosen
     here, out of what is actually running — which is the only list that can
     answer it, because an artifact outlives the conversation that made it and
     the library is full of ones whose workspace is gone.
     `Ended` is the whole filter: a session in any other state has an agent
     that can be handed a turn. */
  const choosing = sendTo === null;
  const sessions = useSessions();
  const running = useMemo(
    () => sessions.data.filter((s) => s.status !== "Ended"),
    [sessions.data],
  );
  /* Undefined until somebody decides, so that the default below can apply once
     the session list has actually arrived rather than racing it. */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const pick = useMenu<null>();

  /* The rule itself lives in `target.ts`, where it can be tested: which of
     these wins, and what happens when the session behind one of them has
     ended, is the whole of the bug this replaced. */
  const madeBy = artifact.fromSessionId ?? null;
  const to = useMemo(
    () => noteTarget({ fixed: sendTo, picked, running, origin: madeBy }),
    [sendTo, picked, running, madeBy],
  );
  const going = running.find((s) => s.id === to) ?? null;

  const rename = async () => {
    const next = (naming ?? "").trim();
    setNaming(null);
    if (!next || next === artifact.title) return;
    try {
      await renameArtifact(artifact.id, { title: next });
      await cache.invalidateQueries({ queryKey: getListArtifactsQueryKey() });
    } catch (e) {
      setNotice(why(e) ?? "Could not rename it.");
    }
  };

  /* The picker needs to be told which window to talk to; it will not guess. */
  const src = origin ? `${artifact.url}#__firetower_ui=${encodeURIComponent(self())}` : undefined;

  /* ⌘F. The page is another origin, so nothing here can read a word of it —
     the search runs inside the frame, in the picker the control plane
     injected, and this side draws the bar, sends the query and shows the
     count that comes back (`preview/bridge`). Same bar as the conversation's,
     same keys. Summoned from here when ⌘F lands in this window, and from the
     page when it lands in the frame, which is where focus is once you have
     clicked or scrolled the document. */
  const [finding, setFinding] = useState(false);
  const [summoned, setSummoned] = useState(0);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const summon = useCallback(() => {
    setFinding(true);
    setSummoned((n) => n + 1);
  }, []);

  const bridge = usePickerBridge(
    frame,
    origin,
    artifact.fromSessionId ?? "",
    null,
    {
      onPath: () => {},
      onSelection: (picked) => {
        const box = frame.current?.getBoundingClientRect() ?? {
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        };
        setDrafting({
          ...picked,
          quote: picked.snapshot.html.trim().slice(0, 400),
          line: 0,
          label: `Note on ${nameOf(picked.snapshot.label, picked.snapshot.html)}`,
          ...anchorIn(box, picked.snapshot.bounds, picked.point),
        });
      },
      onLocated: () => {},
      onFocusNote: () => setShowNotes(true),
      onFound: setFound,
      onFindBar: (open) => (open ? summon() : setFinding(false)),
    },
    // The *version*, verbatim, because that is what the control plane wrote
    // into the page as `data-artifact`. This used to be an invented string
    // (`arv:` + the artifact id), which matched nothing — so the handshake
    // never completed and Annotate was permanently disabled with no clue why.
    artifact.versionId ?? null,
  );

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      /* A workspace keeps every artifact tab mounted behind the one in front,
         hidden, so the frame keeps its page. The key is this tab's only while
         this tab is the one on screen; otherwise it is the conversation's. */
      if (!frame.current || frame.current.getClientRects().length === 0) return;
      /* A focused terminal owns ⌘F — it searches its own scrollback. */
      if ((document.activeElement as HTMLElement | null)?.closest(".xterm")) return;
      e.preventDefault();
      summon();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [summon]);

  /* The query goes to the page as it is typed, and again when the page
     connects — a bar opened before the picker answered would otherwise be
     searching nothing. `found` is cleared first so the count reads as "not
     answered yet" rather than as the previous query's. */
  useEffect(() => {
    if (!finding) return;
    setFound(null);
    bridge.tell({ type: "find", query });
  }, [finding, query, bridge.ready, bridge.tell]);

  /* Nothing of this outlives the bar. The highlights are the page's, and a
     page left glowing after esc would be the app remembering a search nobody
     is running. Reset here rather than on opening, so the bar comes up empty
     the way the conversation's does. */
  useEffect(() => {
    if (!finding) return;
    return () => {
      setQuery("");
      setFound(null);
      bridge.tell({ type: "find", query: "" });
    };
  }, [finding, bridge.tell]);

  /* Esc closes the find bar, leaves annotating after that, and leaves the
     expanded view last — one press, one thing. The bar's own field stops its
     esc before it gets here; this is for when focus is anywhere else. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drafting) return;
      if (finding) setFinding(false);
      else if (bridge.annotating) bridge.tell({ type: "mode", enabled: false });
      else if (expanded) onExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bridge, drafting, finding, expanded, onExpanded]);

  const keep = (text: string) => {
    if (!drafting) return;
    setNotes((held) => [
      ...held,
      {
        id: crypto.randomUUID(),
        what: drafting.snapshot.label,
        html: drafting.snapshot.html,
        text,
        sent: false,
      },
    ]);
    setDrafting(null);
    setShowNotes(true);
    bridge.tell({ type: "clear" });
  };

  const unsent = notes.filter((n) => !n.sent);
  const send = async () => {
    if (!to || unsent.length === 0) return;
    setSending(true);
    const body = `${unsent.length === 1 ? "A note" : `${unsent.length} notes`} on the artifact “${artifact.title}” (v${artifact.version}):\n\n${unsent
      .map((n, i) => `${i + 1}. ${nameOf(n.what, n.html)}\n> ${n.html.replace(/\s+/g, " ").slice(0, 300)}\n\n${n.text}`)
      .join("\n\n")}`;
    try {
      await sendTurn(to, { text: body });
      setNotes((held) => held.map((n) => ({ ...n, sent: true })));
      setNotice(going ? `Sent to ${going.name} as one turn.` : "Sent as one turn.");
    } catch (e) {
      setNotice(why(e) ?? "Could not send those notes.");
    } finally {
      setSending(false);
    }
  };

  if (!origin) return <Plain title="No address for this artifact.">The server could not say where to reach it.</Plain>;

  const body = (
    <div className="relative flex h-full min-h-0 flex-col bg-ground">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        {/* The title is the control. Clicking a name to change it is how the
            rest of this app renames a workspace, and an artifact is the one
            thing here whose name was invented by a poller from a folder. */}
        {naming === null ? (
          <button
            onClick={() => setNaming(artifact.title)}
            title="Rename"
            className="min-w-0 truncate rounded px-1 text-ui font-medium text-bone hover:bg-raise"
          >
            {artifact.title}
          </button>
        ) : (
          <input
            autoFocus
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename();
              if (e.key === "Escape") setNaming(null);
            }}
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-line bg-ground px-1 text-ui font-medium text-bone focus:outline-none"
          />
        )}
        <span className="shrink-0 rounded-full border border-line px-1.5 font-mono text-micro text-mute">
          v{artifact.version}
        </span>
        {artifact.fromWorkspaceName && (
          <span className="shrink-0 truncate text-micro text-mute">from {artifact.fromWorkspaceName}</span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* On is heavier, never a hue. `STYLE.md`: colour is fully spent, and
              anything new is identified by shape, weight or position. Ember in
              particular answers one question — whether somebody is waiting on
              you — so an annotating toggle wearing it was claiming that. This
              is the same treatment every segmented control already uses when a
              segment is on. */}
          <button
            disabled={!bridge.ready}
            onClick={() => {
              bridge.tell({ type: "mode", enabled: !bridge.annotating });
              if (!bridge.annotating) setShowNotes(true);
            }}
            title={bridge.ready ? "Pick an element and write a note on it" : "The page has not connected its picker yet"}
            className={`control ${
              bridge.annotating
                ? "bg-overlay font-medium text-bone shadow-(--shadow-raise)"
                : "border border-line bg-raise text-dim hover:bg-overlay hover:text-bone"
            } disabled:opacity-40`}
          >
            {bridge.annotating ? "Annotating" : "Annotate"}
          </button>
          <button
            onClick={() => setShowNotes((v) => !v)}
            className="control plain text-dim hover:bg-raise hover:text-bone"
            title="Notes on this version"
          >
            Notes {notes.length > 0 && <span className="font-mono text-micro">{notes.length}</span>}
          </button>
          <button
            onClick={() => onExpanded(!expanded)}
            title={expanded ? "Collapse (Esc)" : "Fill the window — annotating keeps working"}
            className="grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} /> : <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} />}
          </button>
          <button
            onClick={() => openExternal(artifact.url)}
            title="Open in the browser — annotating does not work there"
            className="grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          {/* Where it is filed, and the move picker — the same control every
              other Placed kind gets, rather than an artifact-shaped copy of
              one. `may_share` decides server-side whatever this draws. */}
          <WhoCanAccess look="toolbar" kind="artifact" id={artifact.id} path={artifact.path} />
          <div className="relative">
            <button
              onClick={() => setSharing((v) => !v)}
              title="Send it somewhere"
              className="grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
            >
              <Share2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            {sharing && (
              <>
                <button
                  className="fixed inset-0 z-40 cursor-default"
                  aria-label="Close"
                  onClick={() => setSharing(false)}
                />
                <div className="absolute top-full right-0 z-50 mt-1.5 w-[21rem] overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)">
                  <div className="px-3.5 pt-3 pb-2 text-meta text-dim">Share this artifact</div>

                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(artifact.url);
                      setNotice("Link copied.");
                      setSharing(false);
                    }}
                    className="flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-raise/70"
                  >
                    <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
                    <span>
                      <span className="block text-ui text-bone">Copy link</span>
                      {/* "your Firetower network", not "your network": the
                          boundary is this installation's reach, not whatever
                          LAN or VPN somebody happens to be on. The control
                          plane is never on the public internet, so the link is
                          not "public" in the way a URL usually is. */}
                      <span className="mt-0.5 block text-micro text-mute">
                        Opens for anyone who can reach your Firetower network.
                      </span>
                    </span>
                  </button>

                  <button
                    disabled={saving}
                    onClick={async () => {
                      setSaving(true);
                      try {
                        await shell.save(
                          `${apiBase()}/api/v1/artifacts/${artifact.id}/download`,
                          `${artifact.slug || "artifact"}-v${artifact.version}.zip`,
                          token(),
                        );
                        setSharing(false);
                      } catch (e) {
                        setNotice(why(e) ?? "Could not save that.");
                      } finally {
                        setSaving(false);
                      }
                    }}
                    className="flex w-full items-start gap-2.5 border-t border-line px-3.5 py-2 text-left transition-colors hover:bg-raise/70 disabled:opacity-50"
                  >
                    <Download className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
                    <span>
                      <span className="block text-ui text-bone">
                        {saving ? "Saving…" : "Download as .zip"}
                      </span>
                      <span className="mt-0.5 block text-micro text-mute">
                        The whole artifact as files. To send it outside your Firetower network.
                      </span>
                    </span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Relative so the find bar floats over the page itself, clear of the
            header and of the notes beside it. */}
        <div className="relative min-h-0 min-w-0 flex-1">
          <iframe ref={frame} src={src} title={artifact.title} className="h-full w-full border-0 bg-white" />
          {finding && (
            <FindBar
              query={query}
              onQuery={setQuery}
              found={found}
              onStep={(by) => bridge.tell({ type: "find-step", by })}
              onClose={() => setFinding(false)}
              summoned={summoned}
              placeholder="Find in artifact"
              /* Said in the field rather than discovered by typing into it:
                 a picker from an older control plane ignores the query, and
                 a count that never arrives looks like a page with nothing in
                 it. Only once the page has connected — before that, nothing
                 is known either way. */
              disabled={bridge.ready && !bridge.finds ? "Update Firetower to search here" : undefined}
            />
          )}
        </div>

        {showNotes && (
          <aside className="flex w-[17rem] shrink-0 flex-col border-l border-line bg-panel">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="text-meta text-dim">Notes on v{artifact.version}</span>
              <button onClick={() => setShowNotes(false)} className="ml-auto text-mute hover:text-bone">
                ×
              </button>
            </div>
            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
              {notes.length === 0 ? (
                <p className="px-4 py-8 text-center text-meta text-mute">
                  {bridge.ready ? "Press Annotate, then click anything in the page." : "Nothing noted yet."}
                </p>
              ) : (
                notes.map((n, i) => (
                  <div key={n.id} className="group/note border-b border-line-soft px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full font-mono text-[10px] leading-none ${n.sent ? "bg-sage-tint text-sage" : "bg-ember-tint text-ember"}`}
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-micro text-mute">{nameOf(n.what, n.html)}</span>
                      {!n.sent && (
                        <button
                          onClick={() => setNotes((held) => held.filter((x) => x.id !== n.id))}
                          className="grid h-5 w-5 place-items-center rounded text-mute opacity-0 group-hover/note:opacity-100 hover:bg-raise hover:text-brick"
                        >
                          <Trash2 className="h-3 w-3" strokeWidth={1.75} />
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-ui text-text">{n.text}</p>
                    <p className="mt-1 text-micro text-mute">{n.sent ? "sent" : "draft"}</p>
                  </div>
                ))
              )}
            </div>
            {unsent.length > 0 && (
              <div className="shrink-0 border-t border-line p-2.5">
                {/* Only when it is a question. Inside a workspace the answer is
                    the conversation you are looking at, and a row saying so
                    would be a control with one option. */}
                {choosing && (
                  <button
                    onClick={(e) => pick.show(e, null)}
                    disabled={running.length === 0}
                    title={running.length === 0 ? undefined : "Choose which agent these go to"}
                    className="mb-1.5 flex w-full items-center gap-1.5 rounded-md border border-line bg-ground px-2 py-1 text-left hover:border-mute disabled:opacity-50"
                  >
                    <CornerUpRight className="h-3 w-3 shrink-0 text-mute" strokeWidth={1.75} />
                    <span className={`min-w-0 flex-1 truncate text-micro ${going ? "text-text" : "text-mute"}`}>
                      {running.length === 0
                        ? "Nothing is running"
                        : going
                          ? going.name
                          : "Choose an agent"}
                    </span>
                    {running.length > 0 && <ChevronDown className="h-3 w-3 shrink-0 text-mute" strokeWidth={1.75} />}
                  </button>
                )}
                <button
                  disabled={sending || !to}
                  onClick={send}
                  title={
                    to
                      ? undefined
                      : running.length === 0
                        ? "No agent is running to send these to."
                        : "Pick an agent to send these to."
                  }
                  className="control w-full justify-center bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute"
                >
                  {sending ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" strokeWidth={2} />}
                  {sending
                    ? "Sending…"
                    : `Send ${unsent.length} note${unsent.length > 1 ? "s" : ""}${choosing ? "" : " to the agent"}`}
                </button>
              </div>
            )}
          </aside>
        )}
      </div>

      {notice && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border border-line bg-overlay px-3.5 py-1.5 text-meta text-dim shadow-(--shadow-float)">
          {notice}
        </div>
      )}

      {/* Built from what is running at the moment it opens, so a workspace
          that ended while the notes were being written is simply not offered.
          The one that made the artifact is marked, because out of a long list
          it is the one with a reason to be chosen. */}
      {pick.open && (
        <ContextMenu
          at={pick.open.at}
          items={running.map(
            (s): MenuItem => ({
              label: s.name,
              /* `shortcut` is only ever a dim right-aligned hint, and this is
                 what one is for here: workspaces are routinely named the same
                 thing, so a column of identical labels is a menu you cannot
                 choose from. The one that made the artifact says so; the rest
                 say what they are doing. */
              shortcut: s.id === madeBy ? "made this" : s.status,
              onPick: () => setPicked(s.id),
            }),
          )}
          onClose={pick.close}
        />
      )}

      {drafting && (
        <Annotate
          at={drafting}
          onCancel={() => {
            setDrafting(null);
            bridge.tell({ type: "clear" });
          }}
          onKeep={keep}
          onParent={drafting.parents.length > 0 ? () => bridge.tell({ type: "parent", steps: 1 }) : undefined}
        />
      )}
    </div>
  );

  /* Expanded takes the window *below the chrome* — never `inset-0`.
     Two things live in that 38px strip and both broke when this covered it:
     macOS draws its traffic lights there whatever we paint underneath, so the
     toolbar came out beneath them; and the title bar is the window's drag
     region, so covering it meant the window could no longer be moved.
     The frame is never unmounted on the way in or out, because that would
     reload the page and lose the scroll, the picker's connection, and every
     note anchored to what is on screen. */
  return expanded ? (
    // An inline style rather than a Tailwind arbitrary value: nothing else in
    // this app sets an inset from a custom property, so a class that silently
    // generated nothing would leave the bug exactly as it was and look fixed.
    <div className="fixed inset-x-0 bottom-0 z-40 bg-ground" style={{ top: "var(--chrome-title)" }}>
      {body}
    </div>
  ) : (
    body
  );
}

function Plain({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-ground">
      <div className="max-w-[26rem] text-center">
        <p className="text-ui text-dim">{title}</p>
        <p className="mt-2 text-meta text-mute">{children}</p>
      </div>
    </div>
  );
}
