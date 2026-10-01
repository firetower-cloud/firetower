"use client";

/**
 * Deciding what happens to everything that is somebody's, before they go.
 *
 * **Every row answered, or nothing runs.** Removing a person used to be one
 * button behind a sentence true of anybody — *their workspaces go too, and
 * their credentials* — which said nothing about the person in front of you.
 * Whatever it swept was discovered afterwards, or never. The server refuses an
 * incomplete decision; this screen is what makes a complete one possible.
 *
 * **Two answers per row and not three.** *Hand over* moves it. *Let go* means
 * it goes with them, which is deletion for a workspace, a subscription or a
 * secret, and a move to `Shared` for a machine — compute is real and the
 * organisation is still running on it. A third button spelled "delete" would be
 * a lie on the one kind that is never deleted, so each row says what letting go
 * will actually do to *it*.
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

/** What letting go actually does, which is not the same for every kind. */
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
  const { data: directories = [] } = useListDirectories();
  const run = useOffboardUser();
  const [chosen, setChosen] = useState<Record<string, Decision>>({});
  const [trouble, setTrouble] = useState<string | null>(null);

  const owns = reach?.owns ?? [];
  const left = owns.filter((o) => !chosen[o.id]).length;

  /* Destinations: anybody else, and any directory. A person who is going is
     not offered as one. */
  const places = [
    ...colleagues
      .filter((c) => c.id !== person.id)
      .map((c) => ({ value: `person:${c.id}`, label: c.username })),
    ...directories.map((d) => ({ value: `directory:${d.id}`, label: `d/${d.slug}` })),
  ];

  /* Fills only what has not been decided. Overwriting a row somebody chose
     deliberately is the one thing a convenience must not do. */
  const fillRest = (value: string) =>
    setChosen((was) => {
      const next = { ...was };
      for (const o of owns) if (!next[o.id]) next[o.id] = { to: value };
      return next;
    });

  const go = async (then: "disable" | "remove") => {
    setTrouble(null);
    const handOver = owns
      .filter((o) => chosen[o.id] && chosen[o.id] !== "let-go")
      .map((o) => {
        const [kind, id] = (chosen[o.id] as { to: string }).to.split(":");
        return { kind: o.kind, id: o.id, to: { kind, id } };
      });
    const letGo = owns
      .filter((o) => chosen[o.id] === "let-go")
      .map((o) => ({ kind: o.kind, id: o.id }));
    try {
      await run.mutateAsync({ id: person.id, data: { handOver, letGo, then } });
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
            {left > 0
              ? `${left} still to decide`
              : `${owns.length - owns.filter((o) => chosen[o.id] === "let-go").length} handed over · ${owns.filter((o) => chosen[o.id] === "let-go").length} going with them`}
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={left > 0 || run.isPending}
              onClick={() => void go("remove")}
            >
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
          <p className="text-ui text-dim">
            Nothing changes until you confirm — and then all of it changes at once.
          </p>

          {!person.disabled && (
            <p className="rounded-lg border border-line bg-raise px-3 py-2 text-meta text-dim">
              {person.username} can still sign in. Switching them off first stops them making
              anything while you decide.
            </p>
          )}

          {reach.administers.some((a) => a.alone) && (
            <section>
              <h3 className="text-ui text-bone">Only they administer these</h3>
              <p className="mt-1 text-meta text-mute">
                They stay, and an administrator of this Firetower can always reach them — but
                nobody who works there will be able to file anything out, or change who it lets
                in.
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {reach.administers
                  .filter((a) => a.alone)
                  .map((a) => (
                    <li key={a.directoryId}>
                      <Badge>d/{a.slug}</Badge>
                    </li>
                  ))}
              </ul>
            </section>
          )}

          <section>
            <div className="flex items-center gap-3">
              <h3 className="text-ui text-bone">
                Theirs — {owns.length} {owns.length === 1 ? "thing" : "things"}
              </h3>
              {owns.length > 1 && (
                <select
                  defaultValue=""
                  onChange={(e) => e.target.value && fillRest(e.target.value)}
                  className="ml-auto rounded-md border border-line bg-ground px-2 py-1 text-meta text-text"
                >
                  <option value="">hand the rest to…</option>
                  {places.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {owns.length === 0 ? (
              <p className="mt-2 text-meta text-mute">Nothing is filed in their own space.</p>
            ) : (
              <div className="mt-2 divide-y divide-line-soft overflow-hidden rounded-xl border border-line">
                {owns.map((o: Filed) => {
                  const pick = chosen[o.id];
                  return (
                    <div key={o.id} className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui text-bone">{o.name}</span>
                        <span className="block text-micro text-mute">
                          {KINDS[o.kind] ?? o.kind}
                          {o.detail ? ` · ${o.detail}` : ""}
                        </span>
                      </span>
                      <select
                        value={pick && pick !== "let-go" ? pick.to : ""}
                        onChange={(e) =>
                          setChosen((w) => ({ ...w, [o.id]: { to: e.target.value } }))
                        }
                        className={`rounded-md border border-line bg-ground px-2 py-1 text-meta ${
                          pick === "let-go" ? "text-mute line-through" : "text-text"
                        }`}
                      >
                        <option value="">hand over to…</option>
                        {places.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => setChosen((w) => ({ ...w, [o.id]: "let-go" }))}
                        className={`rounded-md px-2 py-1 text-meta ${
                          pick === "let-go"
                            ? "bg-brick-tint text-brick"
                            : "text-mute hover:text-brick"
                        }`}
                      >
                        {goesAs(o.kind)}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {reach.created.length > 0 && (
            <section>
              <h3 className="text-ui text-bone">Stays where it is</h3>
              <p className="mt-1 text-meta text-mute">
                They made these and filed them in a directory, so it owns them now. Nothing to
                decide.
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

          <section>
            <h3 className="text-ui text-bone">Goes without asking</h3>
            <p className="mt-1 text-meta text-mute">
              Access, not property. Their slug is kept forever so nothing can ever be issued it
              again.
            </p>
            <ul className="mt-2 space-y-1 text-meta text-dim">
              {reach.teams.map((t) => (
                <li key={t.id}>{t.name} — team membership</li>
              ))}
              {reach.directories.map((d) => (
                <li key={d.directoryId}>
                  d/{d.slug} · {d.level} —{" "}
                  {d.through.map((r) => (r.how === "team" ? `through ${r.name}` : r.how)).join(", ")}
                </li>
              ))}
              {reach.exceptions.map((e) => (
                <li key={`${e.kind}:${e.id}`}>
                  {e.name} · {e.level} — named on it
                </li>
              ))}
            </ul>
          </section>

          {trouble && <p className="text-ui text-brick">{trouble}</p>}
        </div>
      )}
    </Modal>
  );
}
