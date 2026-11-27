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
 * So this does not ask what to do with each thing. It shows what will be
 * destroyed, clearly enough that nobody finds out afterwards, and asks for the
 * one decision that is genuinely the organisation's: who takes over a directory
 * this person was the last administrator of.
 *
 * **Reached from the person's row rather than as a destination of its own.**
 * It is the confirmation on *Remove*, and a confirmation that is somewhere else
 * is one somebody arrives at without the row they meant. The decision inside it
 * is why it is a sheet rather than `Confirm`'s dialog: `useConfirm` asks yes or
 * no, and this asks who.
 *
 * The hard part is not here. `useUserReach` already answers "everything this
 * person reaches and everything that is theirs" — an administrator's read, and
 * the reason the question is answerable at all — so this is a list of what came
 * back and one picker.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { IconButton } from "~/components/ui";
import {
  getListUsersQueryKey,
  useOffboardUser,
  useUserReach,
} from "~/api/generated/organization/organization";
import type { Filed, FiledKind, Level, User } from "~/api/generated/model";
import { getListColleaguesQueryKey } from "~/api/generated/access/access";
import { why } from "~/data";
import { PickPeople } from "~/ui/PickPeople";
import { offboardingFor } from "~/ui/config/organisation";

/** What a level is called where somebody reads it. `writer` is the wire's. */
const said = (l: Level | string) => (l === "writer" ? "editor" : l);

/** What going actually does, which is not the same for every kind. */
const goesAs = (kind: FiledKind) => (kind === "machine" ? "moves to Shared" : "is deleted");

/** The word for a kind, where the wire's is not one. */
const KINDS: Record<string, string> = {
  workspace: "workspace",
  machine: "machine",
  agentAccount: "subscription",
  secret: "secret",
  skill: "skill",
  artifact: "artifact",
  role: "profile",
  agentTeam: "agent team",
  repository: "repository",
};

export function Offboard({ person, onClose }: { person: User; onClose: () => void }) {
  const cache = useQueryClient();
  const reach = useUserReach(person.id);
  const run = useOffboardUser();
  const [successors, setSuccessors] = useState<
    Record<string, { kind: "person" | "team"; id: string; name: string }>
  >({});
  const [trouble, setTrouble] = useState<string | null>(null);

  const owns = reach.data?.owns ?? [];
  /* The one decision. A directory nobody else administers would be left with
     nobody able to change who it lets in — the organisation's problem rather
     than this person's, which is why it is the only thing being asked. */
  const alone = (reach.data?.administers ?? []).filter((a) => a.alone);

  const go = async () => {
    setTrouble(null);
    try {
      /* What is being agreed to, built in one place — `offboardingFor` — so
         the list read back off the screen and the list sent to the server are
         the same value rather than two expressions of it. The server compares
         it with what is actually theirs and refuses if something arrived in
         between: they are still working until the moment they are switched
         off. */
      await run.mutateAsync({ id: person.id, data: offboardingFor(owns, successors) });
      /* Both lists: the colleague list is what the sharing sheet reads from,
         and somebody who has just gone must stop being offered there too. */
      await Promise.all([
        cache.invalidateQueries({ queryKey: getListUsersQueryKey() }),
        cache.invalidateQueries({ queryKey: getListColleaguesQueryKey() }),
      ]);
      onClose();
    } catch (e) {
      setTrouble(why(e));
    }
  };

  /* **The one decision has to actually be made.** The sheet draws a picker for
     every directory nobody else administers, says *Nobody else can change who
     these let in*, and then let *Remove* through whether or not one was
     chosen — so the question it exists to ask was optional.

     The server does not ask it either: `offboard_user` iterates whatever
     successors arrive, so an empty map deletes the account and leaves the
     directory with nobody able to change who it lets in. That is precisely
     the outcome this sheet is for, reached by pressing the button it drew. */
  const unhanded = alone.filter((a) => !successors[a.directoryId]);

  const revoked =
    (reach.data?.teams ?? []).length > 0 ||
    (reach.data?.directories ?? []).some((d) => d.through.some((r) => r.how === "direct")) ||
    (reach.data?.exceptions ?? []).length > 0;

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-scrim pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label={`Remove ${person.username}`}
        className="flex max-h-[80vh] w-[34rem] flex-col overflow-hidden rounded-xl border border-line lift shadow-(--shadow-float)"
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-bone">Remove {person.username}</span>
            <span className="block truncate text-micro text-mute">
              {owns.length === 0
                ? "Nothing of theirs is destroyed"
                : `${owns.length} ${owns.length === 1 ? "thing" : "things"} destroyed`}
            </span>
          </span>
          <IconButton of={X} label="Close" onClick={onClose} />
        </div>

        <div className="dbody scroll-slim">
          {reach.isPending && <p className="text-ui text-mute">Reading what is theirs…</p>}
          {reach.error && <p className="text-ui text-brick">{why(reach.error)}</p>}

          {reach.data && (
            <div className="flex flex-col gap-6">
              <section>
                {/* **Zero is a sentence, not a count.** *"0 things are
                    destroyed"* above *"Nothing of theirs"* made the heading
                    read as an arithmetic result where the two lines under it
                    were already saying the thing in words — and this sheet's
                    own sub-head had the zero right all along. */}
                <h3 className="text-ui text-bone">
                  {owns.length === 0
                    ? "Nothing of theirs is destroyed"
                    : owns.length === 1
                      ? "1 thing is destroyed"
                      : `${owns.length} things are destroyed`}
                </h3>
                <p className="mt-1 text-meta text-mute">Theirs, so nobody else can be given it.</p>
                {owns.length === 0 ? (
                  <p className="mt-2 text-meta text-mute">Nothing of theirs.</p>
                ) : (
                  <div className="lrows mt-1">
                    {owns.map((o: Filed) => (
                      <div key={`${o.kind}:${o.id}`} className="r">
                        <span className="tx">
                          <b>{o.name}</b>
                          {/* The path, because it is the reason. This is
                              destroyed rather than handed on because of where
                              it is filed, and `u/<them>/…` on the row is that
                              said rather than asserted. */}
                          <s className="font-mono">{o.path}</s>
                        </span>
                        <span className="said">{KINDS[o.kind] ?? o.kind}</span>
                        <span className="said !text-brick">{goesAs(o.kind)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {alone.length > 0 && (
                <section>
                  <h3 className="text-ui text-bone">Only they administer</h3>
                  <p className="mt-1 text-meta text-mute">
                    Nobody else can change who these let in. Make someone an administrator.
                  </p>
                  <div className="lrows mt-1">
                    {alone.map((a) => (
                      <Handover
                        key={a.directoryId}
                        name={a.name}
                        slug={a.slug}
                        chosen={successors[a.directoryId]}
                        exclude={person.id}
                        onPick={(who) =>
                          setSuccessors((w) => {
                            const next = { ...w };
                            if (who) next[a.directoryId] = who;
                            else delete next[a.directoryId];
                            return next;
                          })
                        }
                      />
                    ))}
                  </div>
                </section>
              )}

              {reach.data.created.length > 0 && (
                <section>
                  <h3 className="text-ui text-bone">Stays where it is</h3>
                  <p className="mt-1 text-meta text-mute">Filed in a directory, so they stay.</p>
                  <div className="lrows mt-1">
                    {reach.data.created.map((c) => (
                      <div key={`${c.kind}:${c.id}`} className="r">
                        <span className="tx">
                          <b>{c.name}</b>
                        </span>
                        <span className="path">{c.path.split("/").slice(0, 2).join("/")}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Only what actually disappears. Reach through the team that is
                  everybody is not a row that goes anywhere — the grant stays,
                  the directory is untouched, and listing it under a heading
                  promising removal said the opposite of the truth. */}
              {revoked && (
                <section>
                  <h3 className="text-ui text-bone">Revoked</h3>
                  <ul className="mt-2 flex flex-col gap-1 text-meta text-dim">
                    {reach.data.teams.map((t) => (
                      <li key={t.id}>{t.name} (team)</li>
                    ))}
                    {reach.data.directories
                      .filter((d) => d.through.some((r) => r.how === "direct"))
                      .map((d) => (
                        <li key={d.directoryId}>
                          d/{d.slug} ({said(d.level)})
                        </li>
                      ))}
                    {reach.data.exceptions.map((e) => (
                      <li key={`${e.kind}:${e.id}`}>
                        {e.name} ({said(e.level)})
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>

        <div className="sh-foot">
          {trouble && <span className="where !text-brick">{trouble}</span>}
          {/* Why the button will not go. A disabled control with nothing
              beside it is the interface refusing without saying so, and the
              thing missing here is a decision rather than a permission. */}
          {!trouble && unhanded.length > 0 && (
            <span className="where">
              {unhanded.length === 1
                ? `Choose who administers ${unhanded[0].name} first.`
                : `Choose who administers ${unhanded.length} directories first.`}
            </span>
          )}
          <button onClick={onClose} className="btn quiet ml-auto">
            Cancel
          </button>
          <button
            disabled={run.isPending || !reach.data || unhanded.length > 0}
            onClick={() => void go()}
            className="btn harm disabled:opacity-50"
          >
            {run.isPending ? "Removing…" : `Remove ${person.username}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One directory nobody else administers, and who takes it on.
 *
 * `PickPeople` rather than a second picker: a grant names a person or a team,
 * and that component is already the one list that offers both with a box to
 * type in. The web's own version of this screen grew its own, and its first
 * option read *"nobody takes over"* — which named neither what would happen nor
 * to what.
 */
function Handover({
  name,
  slug,
  chosen,
  exclude,
  onPick,
}: {
  name: string;
  slug: string;
  chosen?: { kind: "person" | "team"; id: string; name: string };
  exclude: string;
  onPick: (who: { kind: "person" | "team"; id: string; name: string } | undefined) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="r">
        <span className="tx">
          <b>{name}</b>
          <s className="font-mono">d/{slug}</s>
        </span>
        {chosen ? (
          <>
            <span className="said">{chosen.name} will administer it</span>
            <button onClick={() => onPick(undefined)} className="text-meta text-mute hover:text-bone">
              change
            </button>
          </>
        ) : (
          !open && (
            <button onClick={() => setOpen(true)} className="btn plain">
              Make someone an administrator
            </button>
          )
        )}
      </div>
      {/* Opened under the row rather than over it: a card positioned on top of
          this one is clipped by the sheet containing it, which put the list
          behind the edge and the directory's own name underneath the box. */}
      {open && !chosen && (
        <PickPeople
          already={[exclude]}
          empty="Nobody else to hand it to."
          placeholder="Find a person or a team"
          onClose={() => setOpen(false)}
          onPick={(w) => {
            onPick({ kind: w.kind, id: w.id, name: w.name });
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
