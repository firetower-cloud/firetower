"use client";

/**
 * What goes when somebody goes, said before it happens.
 *
 * **Nothing of theirs can be handed to anybody, including by an
 * administrator.** What is filed at `u/<them>/…` is theirs; removing the
 * account destroys it, and that is unavoidable because the account is going
 * either way — but passing it to a third party is the one outcome its owner
 * never agreed to. The only way out of a personal root is the owner moving it
 * themselves, before they go.
 *
 * So this screen does not ask what to do with each thing. It shows what will be
 * destroyed, clearly enough that nobody finds out afterwards, and asks for the
 * one decision that is genuinely the organisation's: who takes over a directory
 * this person was the last administrator of.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListUsersQueryKey,
  useOffboardUser,
  useUserReach,
} from "@/src/api/generated/organization/organization";
import { useListColleagues, useListDirectories } from "@/src/api/generated/access/access";
import type { Filed, FiledKind, User } from "@/src/api/generated/model";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/Modal";
import { ApiError } from "@/src/api/http";

const why = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work.");

/** What a level is called where somebody reads it. */
const said = (l: string) => (l === "writer" ? "editor" : l);

/** What going actually does, which is not the same for every kind. */
function goesAs(kind: FiledKind): string {
  return kind === "machine" ? "moves to Shared" : "is deleted";
}

const KINDS: Record<string, string> = {
  workspace: "workspace",
  machine: "machine",
  agentAccount: "subscription",
  secret: "secret",
};

type Decision = { to: string } | "let-go";

export function Offboard({ person, onClose }: { person: User; onClose: () => void }) {
  const cache = useQueryClient();
  const { data: reach, isPending, error } = useUserReach(person.id);
  const { data: colleagues = [] } = useListColleagues();
  const run = useOffboardUser();
  const [successors, setSuccessors] = useState<Record<string, string>>({});
  const [trouble, setTrouble] = useState<string | null>(null);

  const owns = reach?.owns ?? [];
  const alone = (reach?.administers ?? []).filter((a) => a.alone);

  const go = async () => {
    setTrouble(null);
    try {
      await run.mutateAsync({
        id: person.id,
        data: {
          destroy: owns.map((o) => ({ kind: o.kind, id: o.id })),
          successors: Object.entries(successors)
            .filter(([, who]) => who)
            .map(([directory, who]) => ({
              directory,
              subjectKind: "person" as const,
              subjectId: who,
            })),
          then: "remove",
        },
      });
      await cache.invalidateQueries({ queryKey: getListUsersQueryKey() });
      onClose();
    } catch (e) {
      setTrouble(why(e));
    }
  };

  return (
    <Modal
      title={`Remove ${person.username}`}
      onClose={onClose}
      wide
      floor={
        <div className="flex items-center gap-3">
          <span className="text-meta text-mute">
            {owns.length === 0
              ? "Nothing of theirs is destroyed"
              : `${owns.length} ${owns.length === 1 ? "thing" : "things"} destroyed`}
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger" disabled={run.isPending} onClick={() => void go()}>
              {run.isPending ? "Removing…" : `Remove ${person.username}`}
            </Button>
          </div>
        </div>
      }
    >
      {isPending && <p className="text-ui text-mute">Reading what is theirs…</p>}
      {error && <p className="text-ui text-brick">{why(error)}</p>}

      {reach && (
        <div className="space-y-6">
          <section>
            <h3 className="text-ui text-bone">
              {owns.length === 1 ? "1 thing is destroyed" : `${owns.length} things are destroyed`}
            </h3>
            <p className="mt-1 text-meta text-mute">
              Theirs, so nobody else can be given it.
            </p>
            {owns.length === 0 ? (
              <p className="mt-2 text-meta text-mute">Nothing of theirs.</p>
            ) : (
              <div className="mt-2 divide-y divide-line-soft overflow-hidden rounded-xl border border-brick-deep/50">
                {owns.map((o: Filed) => (
                  <div key={o.id} className="flex items-center gap-2.5 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-bone">{o.name}</span>
                      <span className="block text-micro text-mute">
                        {KINDS[o.kind] ?? o.kind}
                        {o.detail ? ` · ${o.detail}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-meta text-brick">{goesAs(o.kind)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {alone.length > 0 && (
            <section>
              <h3 className="text-ui text-bone">Only they administer</h3>
              <p className="mt-1 text-meta text-mute">
                Hand it on, or only administrators can change it.
              </p>
              <div className="mt-2 divide-y divide-line-soft overflow-hidden rounded-xl border border-line">
                {alone.map((a) => (
                  <div key={a.directoryId} className="flex items-center gap-2.5 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-ui text-bone">{a.name}</span>
                      <span className="block font-mono text-micro text-mute">d/{a.slug}</span>
                    </span>
                    <select
                      value={successors[a.directoryId] ?? ""}
                      onChange={(e) =>
                        setSuccessors((w) => ({ ...w, [a.directoryId]: e.target.value }))
                      }
                      className="rounded-md border border-line bg-ground px-2 py-1 text-meta text-text"
                    >
                      <option value="">nobody takes over</option>
                      {colleagues
                        .filter((c) => c.id !== person.id)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.username}
                          </option>
                        ))}
                    </select>
                  </div>
                ))}
              </div>
            </section>
          )}

          {reach.created.length > 0 && (
            <section>
              <h3 className="text-ui text-bone">Stays where it is</h3>
              <p className="mt-1 text-meta text-mute">
                Filed in a directory, so they stay.
              </p>
              <div className="mt-2 divide-y divide-line-soft overflow-hidden rounded-xl border border-line">
                {reach.created.map((c) => (
                  <div key={c.id} className="flex items-center gap-2.5 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-ui text-text">{c.name}</span>
                    <span className="font-mono text-micro text-mute">
                      {c.path.split("/").slice(0, 2).join("/")}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Only what actually disappears. Reach through the team that is
              everybody is not a row that goes anywhere — the grant stays, the
              directory is untouched, and listing it under a heading promising
              removal said the opposite of the truth. */}
          {(reach.teams.length > 0 ||
            reach.directories.some((d) => d.through.some((r) => r.how === "direct")) ||
            reach.exceptions.length > 0) && (
            <section>
              <h3 className="text-ui text-bone">Revoked</h3>
              <ul className="mt-2 space-y-1 text-meta text-dim">
                {reach.teams.map((t) => (
                  <li key={t.id}>{t.name} (team)</li>
                ))}
                {reach.directories
                  .filter((d) => d.through.some((r) => r.how === "direct"))
                  .map((d) => (
                    <li key={d.directoryId}>
                      d/{d.slug} ({said(d.level)})
                    </li>
                  ))}
                {reach.exceptions.map((e) => (
                  <li key={`${e.kind}:${e.id}`}>
                    {e.name} ({said(e.level)})
                  </li>
                ))}
              </ul>
            </section>
          )}

          {trouble && <p className="text-ui text-brick">{trouble}</p>}
        </div>
      )}
    </Modal>
  );
}
