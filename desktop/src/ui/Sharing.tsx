"use client";

/**
 * Where this workspace is filed, and therefore who can reach it.
 *
 * **One choice, not a set of ticks.** A thing lives at one path: `u/kevin/…` is
 * your own space, `d/backend/…` is a directory. It was a checklist while a
 * workspace could be in several directories at once, and that shape is gone —
 * with one path there is exactly one answer, and offering ticks would imply an
 * arrangement the server cannot hold.
 *
 * **Picking a directory hands it over.** Whoever moves it keeps it through
 * whatever grant they hold there, and nothing else. That is said in the dialog,
 * every time, in the line under each option — a transfer somebody did not know
 * they were making is the one failure this screen has to prevent.
 *
 * **A dialog rather than a panel**, which this was first. The workbench already
 * has a drawer on its right edge — the inspector — and a second one competing
 * for the same side means opening this squeezes the transcript between two
 * panels. Filing is a task with an end: open, pick, leave.
 *
 * **Not everybody may pick.** Moving something needs admin where it is filed,
 * or it being in your own space. This used to offer the whole list to anybody
 * who could open the workspace, so somebody with a *look* at a directory was
 * shown "Your own space" and got a refusal when they took it. It now says where
 * the workspace is and why they cannot move it — the same answer, before the
 * click instead of after.
 *
 * Picking is immediate. There is no Save, because there is nothing to hold:
 * one path, one request, and batching would invent a transaction the server has
 * not got.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, UserRound, X, type LucideIcon } from "lucide-react";
import { Icon } from "~/components/ui";
import { fileItems, getListDirectoriesQueryKey, unfileItems } from "~/api/generated/access/access";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import type { Directory } from "~/api/generated/model";
import { useMe } from "~/api/generated/auth/auth";
import { useDirectories, why } from "~/data";
import { destinations, mayMove, rootOf } from "~/filing";

export function Sharing({
  workspaceId,
  path,
  onClose,
}: {
  workspaceId: string;
  /** Where it is now, from the workspace itself — `u/kevin/…` or `d/backend/…`. */
  path: string;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const { data: directories, loading } = useDirectories();
  const me = useMe();
  const [busy, setBusy] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const [kind, root] = rootOf(path);
  const here = kind === "d" ? directories.find((d) => d.slug === root) : undefined;

  const refresh = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: getListSessionsQueryKey() }),
      cache.invalidateQueries({ queryKey: getListDirectoriesQueryKey() }),
    ]);

  /** Move it. `null` means back into your own space, which is what unfiling is. */
  const move = async (to: Directory | null) => {
    setBusy(to?.id ?? "mine");
    setTrouble(null);
    try {
      const items = { items: [{ kind: "workspace" as const, id: workspaceId }] };
      if (to) await fileItems(to.id, items);
      // Taking it out is addressed to the directory it is coming out of: the
      // server checks the two agree, so a stale dialog refuses rather than
      // moving something from wherever it has since gone.
      else if (here) await unfileItems(here.id, items);
      await refresh();
      onClose();
    } catch (e) {
      setTrouble(why(e));
    } finally {
      setBusy(null);
    }
  };

  // Two different questions, and they were one for too long. Whether this
  // person may move it at all is about where it is *now*; where it may go is
  // about what they can work in.
  const may = mayMove(path, me.data?.user, directories);
  const filable = destinations(directories);

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-ground/40 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        className="flex max-h-[62vh] w-[26rem] flex-col overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)"
      >
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-bone">Where this is filed</span>
            <span className="block truncate font-mono text-micro text-mute">{path}</span>
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
          >
            <Icon of={X} size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {loading && <p className="px-3.5 py-3 text-ui text-mute">Reading…</p>}

          {/* Where it is, for somebody who may only look. Said rather than
              offered: a list of places they cannot move it to is a list of
              buttons that fail. */}
          {!loading && !may && (
            <p className="px-3.5 py-3 text-ui text-dim">
              {here
                ? `This belongs to ${here.name}, and moving it is for somebody who administers it.`
                : "This is in somebody else's own space. Only they can move it."}
            </p>
          )}

          {may && (
            <>
              <Option
                on={kind === "u"}
                busy={busy === "mine"}
                icon={UserRound}
                title="Your own space"
                note="Nobody else can see it."
                onPick={() => void move(null)}
              />

              {filable.map((d) => (
                <Option
                  key={d.id}
                  on={here?.id === d.id}
                  busy={busy === d.id}
                  icon={FolderOpen}
                  title={d.name}
                  note={`Everybody with access to d/${d.slug} can open it — and it becomes theirs.`}
                  onPick={() => void move(d)}
                />
              ))}

              {filable.length === 0 && (
                <p className="px-3.5 py-3 text-micro text-mute">
                  There is nowhere to share this yet. Make a directory on the
                  Organization screen first.
                </p>
              )}
            </>
          )}
        </div>

        {trouble && (
          <p className="border-t border-line px-3.5 py-2.5 text-micro text-brick">{trouble}</p>
        )}
        {may && (
          <p className="border-t border-line px-3.5 py-2.5 text-micro text-mute">
            Filing this in a directory hands it to that directory. You keep it
            through whatever access you have there.
          </p>
        )}
      </div>
    </div>
  );
}

function Option({
  on,
  busy,
  icon,
  title,
  note,
  onPick,
}: {
  on: boolean;
  busy: boolean;
  icon: LucideIcon;
  title: string;
  note: string;
  onPick: () => void;
}) {
  return (
    <button
      disabled={on || busy}
      onClick={onPick}
      className="flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-raise disabled:cursor-default disabled:hover:bg-transparent"
    >
      {/* Round, because this is one choice out of several and a square box
          would promise that two could be on at once. */}
      <span
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
          on ? "border-bone" : "border-line"
        }`}
      >
        {on && <span className="h-2 w-2 rounded-full bg-bone" />}
      </span>
      <span className="mt-0.5 text-mute">
        <Icon of={icon} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-ui ${on ? "text-bone" : "text-text"}`}>{title}</span>
        <span className="block text-micro text-mute">{busy ? "Moving…" : note}</span>
      </span>
    </button>
  );
}
