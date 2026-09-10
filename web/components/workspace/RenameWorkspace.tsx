"use client";

/**
 * Giving a workspace a name you will recognise later.
 *
 * The control plane has taken a new name since sessions could be renamed, and
 * nothing in the interface has ever asked for one — so every workspace has
 * carried whatever it was called when it was cut, which for a workspace
 * started from an issue is a slug and for one started from a sentence is the
 * first few words of that sentence.
 *
 * That is survivable on a desk, where the rail shows the branch under the name
 * and there is room for both. It is not survivable on a phone, where the name
 * is the header, the header is how you know which workspace you are in, and
 * six of them called `agent/feat-…` are the same header six times.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRenameSession,
  getGetSessionQueryKey,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import type { Session } from "@/src/api/generated/model";
import { Modal } from "@/components/Modal";
import { ApiError } from "@/src/api/http";

export function RenameWorkspace({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const [name, setName] = useState(session.name ?? "");
  const [trouble, setTrouble] = useState<string | null>(null);
  const cache = useQueryClient();
  const rename = useRenameSession();

  const said = name.trim();
  const ok = said.length > 0 && said !== session.name;

  const go = () => {
    if (!ok) return;
    setTrouble(null);
    rename.mutate(
      { id: session.id, data: { name: said } },
      {
        onSuccess: () => {
          cache.invalidateQueries({ queryKey: getGetSessionQueryKey(session.id) });
          cache.invalidateQueries({ queryKey: getListSessionsQueryKey() });
          onClose();
        },
        onError: (e) =>
          setTrouble(e instanceof ApiError ? e.message : "That didn't work."),
      },
    );
  };

  return (
    <Modal title="Rename this workspace" onClose={onClose}>
      <label htmlFor="workspace-name" className="eyebrow mb-1.5 block">
        Name
      </label>
      <input
        id="workspace-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()}
        autoFocus
        maxLength={80}
        className="min-h-[44px] w-full rounded-md border border-line bg-ground px-3 text-ui text-text focus:border-dim focus:outline-none"
      />

      {/* What does not change, said before somebody wonders. A name is ours;
          the branch is git's, and renaming one here would be a lie about the
          other. */}
      <p className="mt-2 font-mono text-micro text-mute">⑂ {session.branch ?? "no branch"}</p>
      <p className="mt-1 text-meta leading-[1.55] text-mute">
        Only what it is called here. The branch and the worktree keep their own names.
      </p>

      {trouble && <p className="mt-3 text-meta text-brick">{trouble}</p>}

      <button
        onClick={go}
        disabled={!ok || rename.isPending}
        className="mt-4 min-h-[44px] w-full rounded-md bg-bone text-ui font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
      >
        {rename.isPending ? "Renaming…" : "Rename"}
      </button>
    </Modal>
  );
}
