/**
 * Adding a skill: drop the folder, look at what was found, confirm.
 *
 * **Nothing is written until the last step.** The drop is read, parsed and
 * checked in the window; the server is not told anything until somebody says
 * so. A screen that imported on drop would make a mis-aimed folder somebody
 * else's problem to undo.
 *
 * **A drop can be several skills.** What is on a person's disk is
 * `~/.claude/skills`, not one folder, so each is reviewed on its own and the
 * ones that cannot be imported are skipped rather than taking the rest down
 * with them.
 *
 * **Only two fields can be edited here**, and they are the two that are
 * reliably wrong on arrival: a name that collides with one an agent already
 * ships, and a description written for somebody else's repository.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FolderDown } from "lucide-react";
import { addVersion, createSkill, matchSkills } from "~/api/generated/skills/skills";
import { why } from "~/data";
import { readDrop, readFiles, size, skillsIn, RISK_SAYS, type Found } from "~/skills";

type Step = "waiting" | "reading" | "review" | "saving";

/** Whether a bundle has anything to do when Import is pressed. */
function importable(s: Found): boolean {
  if (s.errors.length > 0) return false;
  // Already here, unchanged. Nothing would be written, and the server refuses
  // it — so it arrives unticked rather than as a row that fails on import.
  if (s.match?.identical) return false;
  return true;
}

/** What will happen to this bundle, in a few words. */
function verdict(s: Found): { tone: "ok" | "wait" | "bad"; says: string } {
  if (s.errors.length > 0) return { tone: "bad", says: "cannot import" };
  const m = s.match;
  if (!m) return { tone: "ok", says: "new" };
  if (m.identical)
    return { tone: "wait", says: `already imported, unchanged at v${m.version}` };
  if (m.identicalToVersion !== undefined && m.identicalToVersion !== null)
    return { tone: "wait", says: `this is your v${m.identicalToVersion}, since superseded` };
  if (m.mine && m.mayWrite) return { tone: "ok", says: `new version — v${m.version + 1}` };
  if (!m.mine) return { tone: "wait", says: "a skill of this name is shared with you" };
  return { tone: "ok", says: "new" };
}

export function AddSkill({
  seed,
  onClose,
  onDone,
}: {
  /** A drop that already happened on the list behind this. The entries were
   *  read there, because they are only readable while the event is live. */
  seed?: Promise<Awaited<ReturnType<typeof readDrop>>> | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>(seed ? "reading" : "waiting");
  const [over, setOver] = useState(false);
  const [found, setFound] = useState<Found[]>([]);
  const [take, setTake] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const accept = useCallback(async (job: Promise<Awaited<ReturnType<typeof readDrop>>>) => {
    setStep("reading");
    setFailed(null);
    const raw = await job;
    const skills = await skillsIn(raw);

    /* What the library already holds under each of these names, asked once,
       before anything is written. It is what lets a row say "you already have
       this, unchanged" while there is still a choice about it — and dropping
       the same folder twice is how four pairs of identical skills got into a
       library that had no way to tell them apart. */
    try {
      const answers = await matchSkills(
        skills
          .filter((s) => s.errors.length === 0)
          .map((s) => ({
            name: s.name,
            files: s.files.map((f) => ({
              path: f.path,
              hash: f.hash,
              executable: f.executable,
            })),
          })),
      );
      for (const answer of answers) {
        const one = skills.find((s) => s.name === answer.name);
        if (one && answer.found) one.match = answer.found;
      }
    } catch {
      /* Best effort. Without it the review is what it was before — the server
         still refuses an exact duplicate, so the worst case is finding out a
         moment later rather than a moment earlier. */
    }

    setFound(skills);
    setTake(new Set(skills.map((_, i) => i).filter((i) => importable(skills[i]!))));
    setOpen(skills.length === 1 ? 0 : null);
    setStep("review");
  }, []);

  // A drop that landed on the list opens this already reading it.
  useEffect(() => {
    if (seed) accept(seed);
    // Once: `seed` is the promise from one drop, and re-running would read a
    // settled promise again and reset an edited review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = [...take].filter((i) => found[i] && importable(found[i]!));

  const confirm = async () => {
    setStep("saving");
    setFailed(null);
    try {
      for (const i of ready) {
        const s = found[i]!;
        const bundle = {
          name: s.name,
          description: s.description,
          frontmatter: s.frontmatter,
          body: s.body,
          files: s.files,
        };
        /* A bundle that matches something already yours becomes the next
           version of it rather than a second row with the same name. Only
           when it is yours to write to: adding a version to a colleague's
           skill changes what everybody else reads. */
        if (s.match && s.match.mine && s.match.mayWrite && !s.match.identical) {
          await addVersion(s.match.id, bundle);
        } else {
          await createSkill(bundle);
        }
      }
      onDone();
    } catch (e) {
      setFailed(why(e));
      setStep("review");
    }
  };

  /* Two bundles in one drop cannot both become skills of one name, and nor can
     one that would make a second copy of something already in your own space.
     The database refuses it either way; catching it here is what lets somebody
     fix it in the name field rather than read a failure afterwards. */
  const clashes = (() => {
    const seen = new Map<string, number>();
    const out: string[] = [];
    for (const i of ready) {
      const s = found[i]!;
      const n = seen.get(s.name);
      if (n !== undefined) out.push(s.name);
      seen.set(s.name, i);
      // A new skill of a name already yours, where a version is not possible.
      if (s.match?.mine && !s.match.mayWrite) out.push(s.name);
    }
    return [...new Set(out)];
  })();

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        /* Taken off the event synchronously — the entries are readable only
           while it is being handled — and awaited afterwards. */
        accept(readDrop(e.dataTransfer));
      }}
    >
      <button onClick={onClose} className="flex items-center gap-1 text-meta text-mute hover:text-bone">
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        All skills
      </button>

      {step === "waiting" && (
        <>
          <h2 className="mt-3 text-display text-bone">Add a skill</h2>
          <div
            className={`mt-5 grid place-items-center rounded-xl border border-dashed px-6 py-14 text-center transition-colors ${
              over ? "border-slate bg-slate-tint" : "border-line bg-panel/50"
            }`}
          >
            <span className={`grid h-11 w-11 place-items-center rounded-lg bg-raise shadow-raise ${over ? "text-slate" : "text-mute"}`}>
              <FolderDown className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <span className="mt-3 text-lede text-bone">Drop one or many skill folders</span>
            <span className="mt-1.5 max-w-sm text-meta leading-relaxed text-mute">
              Limits are 100 files, 2 MB a file and 25 MB a skill
            </span>
            <span className="mt-4 flex gap-2">
              <button className="control border border-line bg-raise text-ui text-text hover:bg-overlay" onClick={() => picker.current?.click()}>
                Choose a folder
              </button>
            </span>
            {/* `webkitdirectory` is how a window asks for a folder. The same
                input takes a .zip, so there is one control rather than two. */}
            <input
              ref={picker}
              type="file"
              multiple
              // @ts-expect-error — webkitdirectory is not in the DOM types
              webkitdirectory=""
              directory=""
              className="hidden"
              onChange={(e) => accept(readFiles(e.target.files))}
            />
          </div>
        </>
      )}

      {step === "reading" && (
        <p className="mt-10 text-center text-ui text-mute">Reading it — parsing frontmatter, checking names…</p>
      )}

      {(step === "review" || step === "saving") && (
        <>
          <h2 className="mt-3 text-display text-bone">
            {found.length === 1 ? "One skill found" : `${found.length} skills found`}
          </h2>
          <p className="mt-1.5 max-w-prose text-ui leading-relaxed text-dim">
            Read and checked, nothing written. Look over the names and descriptions, then import.
          </p>

          {failed && <p className="mt-3 text-meta text-brick">{failed}</p>}

          <div className="mt-5 border-t border-line-soft">
            {found.map((s, i) => (
              <Entry
                key={`${s.from}-${i}`}
                found={s}
                chosen={take.has(i) && importable(s)}
                open={open === i}
                onToggle={() => {
                  if (!importable(s)) return;
                  setTake((was) => {
                    const next = new Set(was);
                    next.has(i) ? next.delete(i) : next.add(i);
                    return next;
                  });
                }}
                onOpen={() => setOpen(open === i ? null : i)}
                onEdit={(patch) =>
                  setFound((was) => was.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                }
              />
            ))}
          </div>

          <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
            <span className="flex-1 text-meta text-dim">
              {clashes.length > 0 ? (
                <span className="text-brick">
                  Two of these would be called <span className="font-mono">{clashes[0]}</span>. A name is
                  what the agent answers to, so give one of them its own.
                </span>
              ) : (
                <>
                  Importing <b className="font-semibold text-bone">{ready.length}</b>{" "}
                  {ready.length === 1 ? "skill" : "skills"}
                  {found.some((s) => s.match?.mine && s.match.mayWrite && !s.match.identical)
                    ? ", some as new versions of skills you already have."
                    : " into your own space. Nobody else can see them until you file one into a directory."}
                </>
              )}
            </span>
            <button className="control text-ui text-mute hover:text-bone" onClick={onClose}>
              Cancel
            </button>
            <button
              disabled={ready.length === 0 || clashes.length > 0 || step === "saving"}
              onClick={confirm}
              className="control bg-overlay text-ui font-semibold text-bone shadow-raise disabled:bg-raise disabled:font-normal disabled:text-mute"
            >
              {step === "saving"
                ? "Importing…"
                : `Import ${ready.length === 1 ? "skill" : `${ready.length} skills`}`}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Entry({
  found,
  chosen,
  open,
  onToggle,
  onOpen,
  onEdit,
}: {
  found: Found;
  chosen: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onEdit: (patch: Partial<Found>) => void;
}) {
  const broken = found.errors.length > 0;
  const skipped = !broken && !importable(found);
  const said = verdict(found);
  const m = found.match;
  return (
    <div className="border-b border-line-soft">
      <div className="flex items-start gap-3 py-3">
        <button
          role="checkbox"
          aria-checked={chosen}
          aria-disabled={broken || skipped}
          disabled={broken || skipped}
          onClick={onToggle}
          className={`mt-1 grid h-4 w-4 shrink-0 place-items-center rounded ${
            chosen ? "bg-raise shadow-[inset_0_0_0_1px_#4a4a54]" : "shadow-[inset_0_0_0_1px_#3a3a42]"
          } ${broken || skipped ? "cursor-not-allowed opacity-35" : ""}`}
        >
          {chosen && <span className="block h-1.5 w-2.5 -translate-y-px rotate-[-45deg] border-b-2 border-l-2 border-bone" />}
        </button>
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className={`font-mono text-ui font-semibold ${broken ? "text-dim" : skipped ? "text-mute" : "text-bone"}`}>
              {found.name}
            </span>
            {skipped ? (
              <span className="flex items-center gap-1 rounded-full border border-line bg-raise px-2 py-px text-micro font-medium text-text">
                <Check className="h-3 w-3" strokeWidth={2.25} />
                {said.says}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-micro text-dim">
                <span className={`h-1.5 w-1.5 rounded-full ${
                  said.tone === "bad" ? "bg-brick" : said.tone === "wait" ? "bg-slate" : "bg-sage"
                }`} />
                {said.says}
              </span>
            )}
            <span className="text-micro text-mute">
              from <span className="font-mono">{found.from}</span>
            </span>
          </span>
          {found.description && (
            <span className={`mt-1 block max-w-prose text-meta leading-relaxed ${skipped ? "text-mute" : "text-dim"}`}>{found.description}</span>
          )}
          {found.errors.map((e) => (
            <span key={e} className="mt-2 block max-w-prose border-l-2 border-brick-deep pl-3 text-meta leading-relaxed text-brick">
              {e}
            </span>
          ))}
          {found.warnings.map((w) => (
            <span key={w} className="mt-2 block max-w-prose border-l-2 border-slate-deep pl-3 text-meta leading-relaxed text-slate">
              {w}
            </span>
          ))}
          {m && !m.identical && m.mine && m.mayWrite && (
            <span className="mt-2 block max-w-prose border-l-2 border-line pl-3 text-meta leading-relaxed text-dim">
              You have this at v{m.version}. Importing adds v{m.version + 1}; what it is on now stays
              where it is, and any session reading it keeps that version.
              {" "}
              <span className="text-mute">
                {m.unchanged} unchanged
                {m.changed > 0 && ` · ${m.changed} changed`}
                {m.added > 0 && ` · ${m.added} added`}
                {m.removed > 0 && ` · ${m.removed} removed`}
              </span>
            </span>
          )}
          {m && !m.mine && (
            <span className="mt-2 block max-w-prose border-l-2 border-slate-deep pl-3 text-meta leading-relaxed text-slate">
              A skill called <span className="font-mono">{found.name}</span> is already shared with you
              from <span className="font-mono">{m.path.split("/").slice(0, 2).join("/")}</span>. You can
              keep your own copy, but the two cannot both be on in one session — give yours a name of its
              own if you want that.
            </span>
          )}
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <Pill>{found.files.length} files</Pill>
            <Pill>{size(found.bytes)}</Pill>
            {found.risk.map((r) => (
              <Pill key={r} tone="brick">
                {RISK_SAYS[r] ?? r}
              </Pill>
            ))}
            {found.risk.length === 0 && !broken && <Pill>reads only</Pill>}
          </span>
        </button>
        <ChevronRight className={`mt-1 h-3.5 w-3.5 shrink-0 text-mute transition-transform ${open ? "rotate-90" : ""}`} strokeWidth={2} />
      </div>

      {open && !broken && !skipped && (
        <div className="grid grid-cols-2 gap-5 pb-5 pl-7">
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-meta text-dim">Name</span>
              <input
                value={found.name}
                onChange={(e) => onEdit({ name: e.target.value })}
                className="w-full rounded-lg bg-ground px-2.5 py-1.5 font-mono text-ui text-bone shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)] outline-none"
              />
              <span className="text-micro leading-relaxed text-mute">
                What you type as a command, and the folder written onto the worker.
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-meta text-dim">Description</span>
              <textarea
                rows={4}
                value={found.description}
                onChange={(e) => onEdit({ description: e.target.value })}
                className="w-full resize-y rounded-lg bg-ground px-2.5 py-1.5 text-ui leading-relaxed text-bone shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)] outline-none"
              />
              <span className="self-end text-micro tabular-nums text-mute">{found.description.length} of 1024</span>
              <span className="text-micro leading-relaxed text-mute">
                The only part of a skill always in the model's context. It is what decides whether the skill
                is ever reached for.
              </span>
            </label>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-meta text-dim">Frontmatter, as written</span>
              <pre className="max-h-40 overflow-auto rounded-lg bg-ground px-3 py-2 font-mono text-code leading-relaxed text-dim shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)]">
                {Object.entries(found.frontmatter)
                  .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                  .join("\n") || "(nothing)"}
              </pre>
              <span className="text-micro leading-relaxed text-mute">
                Kept byte for byte. Fields only one agent reads are preserved, never rewritten.
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-meta text-dim">Files</span>
              <div className="max-h-40 overflow-auto rounded-lg border border-line">
                {found.files.map((f) => (
                  <div key={f.path} className="flex items-center gap-2 border-b border-line-soft px-2.5 py-1 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-code text-text">{f.path}</span>
                  </div>
                ))}
              </div>
              <span className="text-micro leading-relaxed text-mute">
                Every file is kept, exactly as it was. This is what gets written into the session's own
                skills directory.
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: "brick" }) {
  return (
    <span className={`rounded-full border px-1.5 py-px text-micro ${tone === "brick" ? "border-brick-deep text-brick" : "border-line-soft text-mute"}`}>
      {children}
    </span>
  );
}
