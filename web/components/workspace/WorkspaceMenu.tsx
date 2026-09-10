"use client";

/**
 * Everything a workspace can do that is not Chat, Diff or Ship.
 *
 * Three in the switcher and the rest here. That split is the whole argument
 * for the phone: the two errands somebody opens Firetower on a train for are
 * answering an agent and shipping what it wrote, and a file tree, a port
 * preview and a second agent are neither. Burying them is the point rather
 * than a compromise, and nothing is unreachable.
 *
 * A sheet rather than a dropdown. `SessionMenu` is a dropdown that does some
 * of this on a desk, and its shape does not travel: it anchors itself to a
 * trigger with a measured rectangle, it is 292px wide, and its rows are 32px.
 * What survives the trip is the *actions* — stopping an agent, ending a
 * workspace — and those are the hooks both call, not the drawing.
 *
 * ## No terminal
 *
 * An xterm with no Esc, no Tab and no Ctrl is not a terminal; it is a picture
 * of one. A terminal opened at a desk is simply not reachable here, and is
 * still there when you get back to a real keyboard.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSession,
  useStopSession,
  getGetSessionQueryKey,
  getSessionWorkQueryKey,
} from "@/src/api/generated/sessions/sessions";
import type { AgentView } from "@/src/api/generated/model";
import { Modal } from "@/components/Modal";
import { AgentMark } from "@/components/AgentMark";
import { ApiError } from "@/src/api/http";
import { useOpen } from "@/src/workspace/tabs";
import { useScreen } from "@/src/workspace/screen";
import { useAgentChoices, useStartAgent } from "./StartAgent";
import { CloseWorkspace } from "./CloseWorkspace";
import { RenameWorkspace } from "./RenameWorkspace";

export function WorkspaceMenu({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { data: session } = useGetSession(sessionId);
  const { show } = useScreen();
  const open = useOpen();
  const cache = useQueryClient();
  const stop = useStopSession();

  const [asking, setAsking] = useState<"preview" | "agents" | "rename" | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  const running = session?.status === "Working" || session?.status === "Starting";

  /* One sheet, whose contents change — rather than one sheet swapped for
     another. Below `md` a sheet takes a history entry so the system Back
     button closes it (see `useDismissible`), and replacing the component
     unmounts one layer and mounts another in the same commit: the first pops
     its entry, the second pushes one, and the pop lands on the push. Back then
     left the workspace instead of returning to the menu.

     Keeping the sheet mounted also reads better. Asking which port is a step
     inside "more", not a different place, and the title saying so while the
     frame stays put is what a step looks like. */
  const title =
    asking === "preview"
      ? "Preview a port"
      : asking === "agents"
        ? "Start an agent"
        : (session?.name ?? "Workspace");

  /* ✕ and Back step back one level rather than closing outright, so the way
     out of "which port?" is the way out of everything else on the screen. */
  const back = () => (asking ? setAsking(null) : onClose());

  return (
    <>
    <Modal title={title} onClose={back}>
      {asking === "preview" && (
        <AskPort
          onOpen={(port) => {
            onClose();
            open.preview(port);
          }}
        />
      )}

      {asking === "agents" && <AskAgent onClose={onClose} />}

      {asking === null && (
      <div className="-mx-2 flex flex-col">
        <Item
          label="Files"
          hint="Everything in the worktree"
          onClick={() => {
            onClose();
            show("files");
          }}
        />
        <Item
          label="Preview a port"
          hint="The application running in here"
          onClick={() => setAsking("preview")}
        />
        <Item
          label="Start another agent"
          hint="In this workspace, on its branch"
          onClick={() => setAsking("agents")}
        />

        <Rule />

        <Item label="Rename…" onClick={() => setAsking("rename")} />

        {running && (
          <Item
            label="Stop the agent"
            hint={session?.repo ? "Keeps the workspace and the branch" : "Keeps the workspace"}
            disabled={stop.isPending}
            onClick={() =>
              stop.mutate(
                { id: sessionId },
                {
                  onSuccess: () => {
                    cache.invalidateQueries({ queryKey: getGetSessionQueryKey(sessionId) });
                    cache.invalidateQueries({ queryKey: getSessionWorkQueryKey(sessionId) });
                    onClose();
                  },
                  onError: (e) =>
                    setTrouble(e instanceof ApiError ? e.message : "That didn't work."),
                },
              )
            }
          />
        )}

        <Rule />

        {/* The one destructive thing, under a divider and at the bottom, where
            a thumb travelling down the list has already stopped. It brings its
            own confirmation — see `CloseWorkspace`, which names the branch and
            counts what is not yet pushed. */}
        {session && (
          <div className="px-2 pt-1">
            <CloseWorkspace session={session} prominent />
          </div>
        )}
      </div>
      )}

      {trouble && <p className="mt-3 text-meta text-brick">{trouble}</p>}
    </Modal>

    {/* Its own sheet, over this one. A layer on top of a layer is fine — each
        takes its own history entry and Back unwinds them in order; what is not
        fine is one layer *becoming* another, which is what the note above is
        about. */}
    {asking === "rename" && session && (
      <RenameWorkspace session={session} onClose={() => setAsking(null)} />
    )}
    </>
  );
}

/**
 * Which port the application is on.
 *
 * A field rather than a list, for the same reason the desk's menu asks: nothing
 * knows what is running in there until something answers, and asking is cheaper
 * than discovering. 3000 is filled in because it is what most of them pick.
 */
function AskPort({ onOpen }: { onOpen: (port: number) => void }) {
  const [port, setPort] = useState("3000");
  const n = Number(port);
  const ok = Number.isInteger(n) && n > 0 && n < 65536;

  return (
    <>
      <label htmlFor="preview-port" className="eyebrow mb-1.5 block">
        Which port is it on?
      </label>
      <input
        id="preview-port"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && ok && onOpen(n)}
        // A numeric keypad rather than the full alphabet, and `numeric` rather
        // than `tel` so it is digits without a dial pad's punctuation.
        inputMode="numeric"
        autoFocus
        className="min-h-[44px] w-full rounded-md border border-line bg-ground px-3 font-mono text-ui text-text focus:border-dim focus:outline-none"
      />
      <p className="mt-2 text-meta leading-[1.55] text-mute">
        The application running in this workspace, on a port of its machine.
      </p>

      <button
        onClick={() => ok && onOpen(n)}
        disabled={!ok}
        className="mt-4 min-h-[44px] w-full rounded-md bg-bone text-ui font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
      >
        Open
      </button>
    </>
  );
}

/** The same list the desk's `+` menu offers, as a sheet. */
function AskAgent({ onClose }: { onClose: () => void }) {
  const { workspaceId, choices, isPending, isError, refetch } = useAgentChoices();
  const start = useStartAgent();
  const { show } = useScreen();
  const [trouble, setTrouble] = useState<string | null>(null);

  const begin = async (agent: AgentView["kind"]) => {
    if (!workspaceId) return;
    try {
      await start(workspaceId, agent);
      // Back to the conversation, which is where a new agent will start
      // talking. There is no tab strip here to open it into.
      show("chat");
      onClose();
    } catch (e) {
      setTrouble(e instanceof ApiError ? e.message : "That didn't work.");
    }
  };

  return (
    <>
      {isPending && (
        <p className="text-meta text-mute" aria-busy>
          Looking…
        </p>
      )}

      {isError && (
        <button
          onClick={() => refetch()}
          className="text-meta text-dim transition-colors hover:text-bone"
        >
          Couldn&rsquo;t reach the API. Retry
        </button>
      )}

      {!isPending && !isError && choices.length === 0 && (
        <p className="text-meta leading-[1.55] text-mute">
          No agents configured. Add one under Configuration.
        </p>
      )}

      <div className="-mx-2 flex flex-col">
        {choices.map(({ agent, why }) => (
          <Item
            key={agent.kind}
            mark={agent.kind}
            label={agent.label}
            hint={why ?? "In this workspace, on its branch"}
            disabled={!!why}
            onClick={() => void begin(agent.kind)}
          />
        ))}
      </div>

      {trouble && <p className="mt-3 text-meta text-brick">{trouble}</p>}
    </>
  );
}

function Rule() {
  return <div className="my-2 border-t border-line" />;
}

/** One row. 52px, because a menu on a phone is a list of targets. */
function Item({
  label,
  hint,
  mark,
  onClick,
  disabled,
}: {
  label: string;
  hint?: string;
  /** An agent's own mark, where the row is about one. */
  mark?: React.ComponentProps<typeof AgentMark>["agent"];
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[52px] w-full items-center gap-3 rounded-md px-2 text-left transition-colors enabled:hover:bg-raise disabled:opacity-45"
    >
      {mark && <AgentMark agent={mark} size={16} className="shrink-0 text-mute" />}
      <span className="min-w-0 flex-1">
        <span className="block text-ui text-text">{label}</span>
        {hint && <span className="block text-meta text-mute">{hint}</span>}
      </span>
    </button>
  );
}
