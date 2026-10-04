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
import { ChevronLeft, ChevronRight, FolderDown } from "lucide-react";
import { createSkill } from "~/api/generated/skills/skills";
import { why } from "~/data";
import { readDrop, readFiles, size, skillsIn, RISK_SAYS, type Found } from "~/skills";

type Step = "waiting" | "reading" | "review" | "saving";

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
    const skills = skillsIn(raw);
    setFound(skills);
    setTake(new Set(skills.map((_, i) => i).filter((i) => skills[i]!.errors.length === 0)));
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

  const confirm = async () => {
    setStep("saving");
    setFailed(null);
    try {
      for (const i of [...take]) {
        const s = found[i]!;
        await createSkill({
          name: s.name,
          description: s.description,
          frontmatter: s.frontmatter,
          body: s.body,
          files: s.files,
        });
      }
      onDone();
    } catch (e) {
      setFailed(why(e));
      setStep("review");
    }
  };

  const ready = [...take].filter((i) => found[i]?.errors.length === 0);

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
          <p className="mt-1.5 max-w-prose text-ui leading-relaxed text-dim">
            A skill is a folder with a <span className="font-mono text-code">SKILL.md</span> inside it. Drop
            one here and Firetower reads it, checks it and shows you what it found. Nothing reaches the
            library until you say so.
          </p>
          <div
            className={`mt-5 grid place-items-center rounded-xl border border-dashed px-6 py-14 text-center transition-colors ${
              over ? "border-slate bg-slate-tint" : "border-line bg-panel/50"
            }`}
          >
            <span className={`grid h-11 w-11 place-items-center rounded-lg bg-raise shadow-raise ${over ? "text-slate" : "text-mute"}`}>
              <FolderDown className="h-5 w-5" strokeWidth={1.75} />
            </span>
            <span className="mt-3 text-lede text-bone">Drop a skill folder</span>
            <span className="mt-1.5 max-w-sm text-meta leading-relaxed text-mute">
              Or a <span className="font-mono text-code">.zip</span> of one, or a folder holding several —
              your <span className="font-mono text-code">~/.claude/skills</span> works as it is.
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
          <div className="mt-5 grid grid-cols-3 gap-4">
            <Way title="Several at once" says="Drop a folder of folders and each is reviewed separately. Untick the ones you do not want." />
            <Way title="However you have it" says="A zip is how skills are published, so a download imports untouched. So does a folder you already keep." />
            <Way title="Nothing is shared yet" says="A skill lands in your own space. Sharing it with a directory is a separate, deliberate act." />
          </div>
          <p className="mt-5 max-w-prose border-l-2 border-line pl-3 text-meta leading-relaxed text-mute">
            Limits are 100 files, 2 MB a file and 25 MB a skill — about four times the largest skill
            Anthropic publishes.
          </p>
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
                chosen={take.has(i)}
                open={open === i}
                onToggle={() => {
                  if (s.errors.length) return;
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
              Importing <b className="font-semibold text-bone">{ready.length}</b>{" "}
              {ready.length === 1 ? "skill" : "skills"} into your own space. Nobody else can see them until
              you file one into a directory.
            </span>
            <button className="control text-ui text-mute hover:text-bone" onClick={onClose}>
              Cancel
            </button>
            <button
              disabled={ready.length === 0 || step === "saving"}
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

function Way({ title, says }: { title: string; says: string }) {
  return (
    <div className="border-l border-line-soft pl-3 first:border-l-0 first:pl-0">
      <p className="text-ui font-semibold text-text">{title}</p>
      <p className="mt-1 text-meta leading-relaxed text-mute">{says}</p>
    </div>
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
  return (
    <div className="border-b border-line-soft">
      <div className="flex items-start gap-3 py-3">
        <button
          role="checkbox"
          aria-checked={chosen}
          disabled={broken}
          onClick={onToggle}
          className={`mt-1 grid h-4 w-4 shrink-0 place-items-center rounded ${
            chosen ? "bg-raise shadow-[inset_0_0_0_1px_#4a4a54]" : "shadow-[inset_0_0_0_1px_#3a3a42]"
          } ${broken ? "opacity-35" : ""}`}
        >
          {chosen && <span className="block h-1.5 w-2.5 -translate-y-px rotate-[-45deg] border-b-2 border-l-2 border-bone" />}
        </button>
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className={`font-mono text-ui font-semibold ${broken ? "text-dim" : "text-bone"}`}>
              {found.name}
            </span>
            <span className="flex items-center gap-1.5 text-micro text-dim">
              <span className={`h-1.5 w-1.5 rounded-full ${broken ? "bg-brick" : found.warnings.length ? "bg-slate" : "bg-sage"}`} />
              {broken ? "cannot import" : found.warnings.length ? "worth a look" : "ready"}
            </span>
            <span className="text-micro text-mute">
              from <span className="font-mono">{found.from}</span>
            </span>
          </span>
          {found.description && (
            <span className="mt-1 block max-w-prose text-meta leading-relaxed text-dim">{found.description}</span>
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

      {open && !broken && (
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
