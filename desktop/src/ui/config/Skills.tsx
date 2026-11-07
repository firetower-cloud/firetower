/**
 * The skill library.
 *
 * A skill is a folder with a `SKILL.md` in it, and it is **Placed** like every
 * other kind — so sharing one is `WhoCanAccess`, the same sheet a machine or a
 * subscription uses, and nothing here reimplements filing.
 *
 * **There is no editor.** Nobody writes these by hand; Anthropic's own answer
 * to authoring one is that an agent does it. So a skill arrives by being
 * dropped, and a *version* is made by dropping the folder again — which is why
 * only two fields can be changed in place. `name`, because a collision has to
 * be fixable, and `description`, because it is the only part that lives in the
 * model's context and an imported one written for somebody else's repository
 * mis-fires constantly.
 *
 * **Everything else is reported, never configured.** What a bundle holds, what
 * it costs, and what it will do to a session are facts about the thing, and a
 * control beside a fact invites somebody to change what they have no say over.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, FolderDown, Loader2, Plus, Search, ShieldAlert, Sparkles, Trash2, TriangleAlert, UserPlus } from "lucide-react";
import { Blank, Rows, Section } from "~/ui/config/bits";
import { ShareMany, WhoCanAccess } from "~/ui/Sharing";
import { AddSkill } from "~/ui/AddSkill";
import { CreateMenu } from "~/ui/config/CreateMenu";
import { useStart } from "~/start";
import { useSkills, useSkillDetail, useSkillVersions, why } from "~/data";
import { elapsed, minutesSince } from "~/api/view";
import { useRepos } from "~/data";
import {
  deleteSkill,
  setDefault,
  approveSkill,
  discardSkill,
  useReviewSkill,
} from "~/api/generated/skills/skills";
import { useQueryClient } from "@tanstack/react-query";
import { useMe } from "~/api/generated/auth/auth";
import { getListSkillsQueryKey } from "~/api/generated/skills/skills";
import type { Skill } from "~/api/generated/model";
import { useConfirm } from "~/ui/Confirm";
import { Markdown } from "~/components/Markdown";
import { readDrop, readFiles, size, RISK_SAYS, type Found } from "~/skills";
import { useOpened } from "~/ui/opened";

export function Skills({ open: asked = null }: { open?: string | null }) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useOpened(asked);
  const [query, setQuery] = useState("");
  const [over, setOver] = useState(false);
  /* A folder dropped on the list goes straight into the review, so the way in
     that the empty state describes is the way in that works. The entries are
     only readable while the event is being handled, so the read starts here
     and the promise is handed on. */
  const seed = useRef<ReturnType<typeof readDrop> | null>(null);
  const feed = useSkills();
  const cache = useQueryClient();
  const confirm = useConfirm();
  const start = useStart();
  const me = useMe();
  // An organisation admin may move anything filed in a directory, so the
  // first section holds more for them, and its note says why.
  const orgAdmin = me.data?.user?.role === "admin";
  const refresh = () => cache.invalidateQueries({ queryKey: getListSkillsQueryKey() });

  /* Several at once. Only what this person may move can be ticked, so the
     action bar never offers something the server would refuse. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sharing, setSharing] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const selected = feed.data.filter((s) => picked.has(s.id) && s.mayShare);
  const clear = () => {
    setPicked(new Set());
    setTrouble(null);
  };

  useEffect(() => {
    if (picked.size === 0 || sharing) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && clear();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [picked.size, sharing]);

  const toggle = (id: string) =>
    setPicked((was) => {
      const next = new Set(was);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const removeAll = async () => {
    const n = selected.length;
    const ok = await confirm({
      title: `Delete ${n === 1 ? selected[0]!.name : `${n} skills`}?`,
      body: "Every version goes. Sessions using them lose them on their next turn.",
      action: n === 1 ? "Delete skill" : `Delete ${n} skills`,
      tone: "danger",
    });
    if (!ok) return;
    setDeleting(true);
    const failed: string[] = [];
    for (const s of selected) {
      try {
        await deleteSkill(s.id);
      } catch {
        failed.push(s.name);
      }
    }
    setDeleting(false);
    await refresh();
    setPicked(new Set(selected.filter((s) => failed.includes(s.name)).map((s) => s.id)));
    setTrouble(failed.length ? `Could not delete ${failed.join(", ")}.` : null);
  };

  const add = (dropped?: ReturnType<typeof readDrop>) => {
    seed.current = dropped ?? null;
    setAdding(true);
  };

  if (adding)
    return (
      <AddSkill
        seed={seed.current}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          refresh();
        }}
      />
    );

  const chosen = feed.data.find((s) => s.id === open);
  if (chosen)
    return <Detail skill={chosen} onBack={() => setOpen(null)} onChanged={refresh} onNewVersion={() => add()} />;

  const q = query.trim().toLowerCase();
  const shown = q
    ? feed.data.filter(
        (s) =>
          s.name.includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.author ?? "").toLowerCase().includes(q),
      )
    : feed.data;
  const tickable = shown.filter((s) => s.mayShare);
  const allOn = tickable.length > 0 && tickable.every((s) => picked.has(s.id));
  /* Three groups, and they are the three the path already encodes: what
     Firetower ships, what is yours, and what somebody filed into a directory
     you can reach. The built-ins are split out of "shared with you" because
     they are not shared *with* you by anybody — they arrive with the product,
     and lumping them in made it look as though a colleague had sent them. */
  const builtIn = shown.filter((s) => s.builtin);
  const sharedWithMe = shown.filter((s) => !s.mayShare && !s.builtin);

  /**
   * One skill.
   *
   * A 38px plate carrying its monogram, the name and what state it is in, two
   * lines of what it does, and **what it can do to your machine as a line of
   * small amber marks** rather than a row of filled badges. Four badges read
   * as four errors; the fact is "worth reading before you approve", which is
   * what amber means and brick does not.
   */
  const row = (s: Skill, manage: boolean) => (
    <div key={s.id} className={`relative ${picked.has(s.id) ? "rounded-xl bg-raise" : ""}`}>
      <button onClick={() => setOpen(s.id)} className="sk w-full" title={s.name}>
        <span className="plate">{monogram(s.name)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="min-w-0 truncate text-ui font-medium text-bone">{s.name}</span>
            <span className="shrink-0 text-meta tabular-nums text-mute">
              {s.held ? "waiting for you" : s.builtin ? "from Firetower" : s.version > 0 ? `v${s.version}` : "pending review"}
            </span>
            {s.alwaysOn && <span className="shrink-0 text-meta text-mute">on by default</span>}
          </span>
          {/* **No `block` here.** `line-clamp-2` sets `display: -webkit-box`
              and `block` sets `display: block`; both are display utilities, so
              whichever Tailwind emitted last won — and it was `block`. The
              clamp was in the class list and doing nothing, so a one-line
              description and a five-line one made two different row heights
              and the list read as ragged. */}
          <span className="ds mt-1 text-ui leading-snug text-dim">{s.description}</span>
          {s.risk.length > 0 && (
            <span className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
              {s.risk.map((r) => (
                <span key={r} className="risk">
                  <i />
                  {r}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="mt-2 flex shrink-0 items-center gap-2.5">
          <WhoCanAccess look="chip" kind="skill" id={s.id} path={s.path} />
        </span>
      </button>
      {/* Selecting several to share or delete them together. On the plate's
          corner and only once you are here, so a hundred rows are a hundred
          skills rather than a hundred checkboxes. */}
      {manage && (
        <span className={`absolute top-3.5 left-0 ${picked.has(s.id) ? "" : "opacity-0 focus-within:opacity-100 hover:opacity-100"} transition-opacity`}>
          <Tick on={picked.has(s.id)} label={`Select ${s.name}`} onFlip={() => toggle(s.id)} />
        </span>
      )}
    </div>
  );

  const surface = {
    onDragOver: (e: React.DragEvent) => {
      if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      add(readDrop(e.dataTransfer));
    },
  };

  if (!feed.loading && !feed.error && feed.data.length === 0)
    return (
      <section {...surface}>
        <Empty
          over={over}
          onAdd={add}
          onCreateWithAI={() => start({ prompt: "Create a Firetower skill that " })}
        />
      </section>
    );

  const held = shown.filter((s) => s.held);
  const mine = tickable.filter((s) => !s.held);

  return (
    /* `data-wide` tells `Configuration.tsx` to drop its 48rem column: this
       pane brings its own `.pcol`, and two centred columns inside each other
       is a 770px page inside a 1120px one. */
    <div {...surface} data-wide className="pcol relative">
      {over && (
        <div className="drop">
          <div>
            <span className="mx-auto grid h-14 w-14 place-items-center text-dim">
              <FolderDown className="h-7 w-7" strokeWidth={1.5} />
            </span>
            <b className="mt-2 block text-lede font-mid text-bone">Drop the folder</b>
            <p className="mt-1 max-w-[46ch] text-ui text-dim">
              One skill, a folder of them, or a .zip of either. Nothing is written until you have looked at
              what was found.
            </p>
          </div>
        </div>
      )}

      <div className="phead2">
        <div className="min-w-0">
          <h1>Skills</h1>
          <p className="sub">
            A folder of instructions an agent reads when it decides it is relevant. Share one, and everybody
            in that directory gets it.
          </p>
        </div>
        <div className="acts">
          <label className="find">
            <Search className="h-[15px] w-[15px] shrink-0" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or description"
              spellCheck={false}
              aria-label="Search skills"
              className="placeholder:text-mute focus:outline-none"
            />
          </label>
          <CreateMenu
            label="Add a skill"
            choices={[
              {
                icon: Sparkles,
                label: "Create with AI",
                note: "Describe it; an agent writes it for you.",
                onPick: () => start({ prompt: "Create a Firetower skill that " }),
              },
              {
                icon: FolderDown,
                label: "Upload a folder",
                note: "A skill you already have, dropped in.",
                onPick: () => add(),
              },
            ]}
          />
        </div>
      </div>

      {/* An agent wrote one and it is waiting. First, because it is the only
          thing on this screen that wants a decision. */}
      {held.length > 0 && (
        <section className="sksec">
          <div className="hd">
            <h2>Waiting for you</h2>
            <span className="n">{held.length}</span>
          </div>
          <div className="review">
            <h3>An agent wrote {held.length === 1 ? "this one" : "these"}, and {held.length === 1 ? "it runs" : "they run"} code</h3>
            <p>
              Read every file before you approve {held.length === 1 ? "it" : "them"}. A held skill can ship
              executable scripts and register hooks for the whole session, so it runs on every turn rather
              than only when it is invoked.
            </p>
          </div>
          <div className="skgrid mt-1">{held.map((s) => row(s, true))}</div>
        </section>
      )}

      <Group
        title="Yours"
        count={mine.length}
        note={
          orgAdmin
            ? "Yours, or in any directory, since you're an organisation admin. Select several to share or delete them together."
            : "Yours, or in a directory you administer. Select several to share or delete them together."
        }
        empty={query ? `No skill you manage matches “${query}”.` : "None yet. Add one to get started."}
      >
        {mine.map((s) => row(s, true))}
      </Group>

      {builtIn.length > 0 && (
        <Group
          title="From Firetower"
          count={builtIn.length}
          note="Shipped with the product and on by default. They cannot be deleted — turn one off for a single session in the composer."
        >
          {builtIn.map((s) => row(s, false))}
        </Group>
      )}

      {sharedWithMe.length > 0 && (
        <Group
          title="Shared with you"
          count={sharedWithMe.length}
          note="You can turn these on in your sessions. Their directory's admins decide who else gets them."
        >
          {sharedWithMe.map((s) => row(s, false))}
        </Group>
      )}

      <p className="mt-9 flex items-center gap-2.5 text-ui text-dim">
        <FolderDown className="h-[15px] w-[15px]" strokeWidth={1.75} />
        Or drop a folder anywhere on this page.
      </p>

      {selected.length > 0 && (
        <div className="pointer-events-none sticky bottom-4 z-20 mt-3 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-2xl bg-panel py-1.5 pr-1.5 pl-3.5 shadow-(--shadow-float)">
            <span className="text-ui tabular-nums text-bone">{selected.length} selected</span>
            {trouble && <span className="max-w-[16rem] truncate text-meta text-brick">{trouble}</span>}
            <button onClick={clear} className="btn quiet">
              Clear
            </button>
            <button disabled={deleting} onClick={() => void removeAll()} className="btn plain text-brick">
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              {deleting ? "Deleting…" : "Delete"}
            </button>
            <button onClick={() => setSharing(true)} className="btn primary">
              <UserPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
              {selected.length === 1 ? "Share skill" : `Share ${selected.length} skills`}
            </button>
          </div>
        </div>
      )}

      {sharing && (
        <ShareMany
          skills={selected}
          onClose={() => setSharing(false)}
          onDone={() => {
            setSharing(false);
            clear();
          }}
        />
      )}
    </div>
  );
}

/** A section of the gallery: a heading, a count, a sentence, and its rows. */
function Group({
  title,
  count,
  note,
  empty,
  children,
}: {
  title: string;
  count: number;
  note: string;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="sksec">
      <div className="hd">
        <h2>{title}</h2>
        <span className="n">{count}</span>
        <p className="note">{note}</p>
      </div>
      {count === 0 && empty ? (
        <p className="mt-3 text-ui text-mute">{empty}</p>
      ) : (
        <div className="skgrid">{children}</div>
      )}
    </section>
  );
}

/**
 * Two letters from the name: identity by shape, never a hue.
 *
 * The initials of the first two words where there are two — `pr-screenshots`
 * is "ps" — and the first two letters where there is one, so `dataviz` is
 * "dv" rather than a lonely "d".
 */
function monogram(name: string): string {
  const words = name.split(/[^a-z0-9]+/i).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toLowerCase();
}

/** A checkbox, drawn the way the import review draws one. */
function Tick({
  on,
  partly = false,
  disabled = false,
  label,
  onFlip,
}: {
  on: boolean;
  partly?: boolean;
  disabled?: boolean;
  label: string;
  onFlip: () => void;
}) {
  return (
    <button
      role="checkbox"
      aria-checked={partly ? "mixed" : on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onFlip}
      /* The ring was two hardcoded greys, which is a dark-only decision and
         invisible on a white page. `--color-line` is the hairline in either
         theme and `--color-dim` is the step up from it. */
      className={`grid h-4 w-4 shrink-0 place-items-center rounded bg-panel ring-1 ${
        on || partly ? "bg-raise ring-dim" : "ring-line"
      } ${disabled ? "cursor-not-allowed opacity-35" : ""}`}
    >
      {on && <span className="block h-1.5 w-2.5 -translate-y-px rotate-[-45deg] border-b-2 border-l-2 border-bone" />}
      {partly && <span className="block h-0.5 w-2 rounded-full bg-bone" />}
    </button>
  );
}

function Empty({
  over,
  onAdd,
  onCreateWithAI,
}: {
  over: boolean;
  onAdd: (d?: ReturnType<typeof readDrop>) => void;
  onCreateWithAI: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`grid place-items-center rounded-xl border border-dashed px-6 py-16 text-center transition-colors ${
        over ? "border-slate bg-slate-tint" : "border-line bg-panel/60"
      }`}
    >
      <span className={`grid h-11 w-11 place-items-center rounded-lg bg-raise shadow-raise ${over ? "text-slate" : "text-mute"}`}>
        <FolderDown className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <h2 className="mt-3.5 text-display font-mid text-bone">No skills yet</h2>
      <p className="mt-2 max-w-sm text-read leading-relaxed text-dim">
        Ask an agent to write one for you, or drop in a skill folder you already have.
      </p>
      <div className="mt-5 flex items-center gap-2">
        <button
          onClick={onCreateWithAI}
          className="btn primary"
        >
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
          Create with AI
        </button>
        <button
          onClick={() => picker.current?.click()}
          className="btn plain"
        >
          Choose a folder
        </button>
      </div>
      <p className="mt-4 text-micro text-mute">Or drop one here</p>
      <input
        ref={picker}
        type="file"
        multiple
        // @ts-expect-error — webkitdirectory is not in the DOM types
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={(e) => onAdd(readFiles(e.target.files))}
      />
    </div>
  );
}


/** Identity by shape, never a hue — the same reasoning as a server's mark. */
function Mark({ name }: { name: string }) {
  const letters = name.split("-").slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase();
  return (
    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line bg-raise font-narrow text-micro font-mid uppercase text-dim shadow-raise">
      {letters}
    </span>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "brick" | "amber" }) {
  return (
    <span
      className={`rounded-full border px-1.5 py-px text-micro ${
        tone === "brick"
          ? "border-brick-deep text-brick"
          : tone === "amber"
            ? "border-amber-deep bg-amber-tint text-amber"
            : "border-line-soft text-mute"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * Three, which is what `desktop-redesign.html:2893` draws.
 *
 * It was four — Details, Bundle, Versions, **Defaults** — because criterion 43
 * named the old app's four and the criterion was written by reading the
 * codebase rather than the drawing. The drawing wins; the criterion was the
 * bug. `Defaults` was not dropped with its tab: the drawing keeps "On by
 * default" as a card in the aside, which is where the fact belongs, so the
 * control lives there now instead of behind a tab of its own.
 */
const TABS = [
  { at: "details", label: "Instructions" },
  { at: "bundle", label: "Files" },
  { at: "versions", label: "Versions" },
] as const;

/**
 * A skill is read-only here. Its name, description and instructions all come
 * from the folder, so the one way to change any of them is a new version of
 * that folder — which the review turns into the next version of this skill.
 */
function Detail({
  skill,
  onBack,
  onChanged,
  onNewVersion,
}: {
  skill: Skill;
  onBack: () => void;
  onChanged: () => void;
  /** The gallery's upload sheet, reached from the one skill it would replace. */
  onNewVersion?: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["at"]>("details");
  const [saving, setSaving] = useState<string | null>(null);
  const confirm = useConfirm();

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${skill.name}?`,
      body: "Every version of it goes, and so does it from any session reading it on the next turn. Nothing else is touched.",
      action: "Delete skill",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteSkill(skill.id);
      onChanged();
      onBack();
    } catch (e) {
      setSaving(why(e));
    }
  };

  const [root, place] = skill.path.split("/");
  const where = root === "d" ? `d/${place}` : "Only you";

  return (
    /* **One padded column**, which is what `openSkill()` is in the drawing:
       a `.pcol` with everything inside it. The build inset seven children
       individually instead, and the one that was forgotten — the tab strip —
       went flush to the window edge with its rule running off it. A page
       whose padding is a property of the page cannot have that happen. */
    <section data-wide className="pcol">
      <div>
      <button onClick={onBack} className="flex items-center gap-1 text-meta text-mute hover:text-bone">
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        All skills
      </button>

      {/* Who it is and what can be done to it, all at the top. */}
      <header className="sk-head">
        {/* The gallery's plate at the detail's size, so the thing you clicked
            and the thing you are reading are plainly the same object. */}
        <span className="plate">{monogram(skill.name)}</span>
        <div className="tx">
          <h1>{skill.name}</h1>
          <div className="facts">
            <span>by {skill.builtin ? "Firetower" : (skill.author ?? "somebody who has left")}</span>
            <span className="tabular-nums">{skill.version > 0 ? `v${skill.version}` : "pending review"}</span>
            <span>updated {elapsed(minutesSince(skill.updatedAt))} ago</span>
            <span>
              {where === "Only you" ? "only you" : <>shared in <b>{where}</b></>}
            </span>
          </div>
          {/* The whole description. It is one sentence and the reason somebody
              opened this; clamping it here was the gallery's rule applied to
              the page the gallery leads to. */}
          <p className="ds">{skill.description}</p>
          <div className="acts">
            {skill.mayWrite && onNewVersion && (
              <button onClick={onNewVersion} className="btn plain">
                <FolderDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                Drop a new version
              </button>
            )}
            <WhoCanAccess look="toolbar" label="Who can use it" kind="skill" id={skill.id} path={skill.path} />
            {skill.mayShare && (
              <button className="btn quiet" onClick={remove}>
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                Delete
              </button>
            )}
          </div>
        </div>
      </header>

      </div>

      {skill.held && (
        <Review skill={skill} onBack={onBack} onChanged={onChanged} />
      )}

      {!skill.held && (<>
      <div className="sk-tabs">
        {TABS.map((t) => (
          <button key={t.at} aria-selected={tab === t.at} onClick={() => setTab(t.at)}>
            {t.label}
          </button>
        ))}
      </div>

      {saving && <p className="pt-3 text-meta text-brick">{saving}</p>}

      {tab === "details" && (
        /* The drawing's two columns: the instructions, and a 268px rail of
           facts cards beside them. The build's aside was a bordered gutter;
           the drawing's cards carry their own ground and need no rule. */
        <div className="sk-body">
          <div className="min-w-0">
            <Instructions id={skill.id} />
          </div>

          <aside className="flex flex-col gap-3 text-meta">
            <Facts
              title="About"
              rows={[
                ["Version", `v${skill.version}`],
                ["Updated", `${elapsed(minutesSince(skill.updatedAt))} ago`],
                ["Author", skill.builtin ? "Firetower" : (skill.author ?? "somebody who has left")],
                ["Size", skill.files ? `${size(skill.bytes)}, ${skill.files} files` : size(skill.bytes)],
                ["Context", `${skill.tokens} tokens a turn`],
              ]}
            />
            <Facts
              title="Access"
              rows={[
                ["Lives in", where],
                ["You can", skill.mayShare ? "manage" : skill.mayWrite ? "edit" : "view"],
              ]}
            />
            <div className="facts-card">
              <h3>What it does to a session</h3>
              {skill.risk.length === 0 ? (
                <span className="line ok">
                  <i />
                  Reads and instructs only
                </span>
              ) : (
                /* **Amber, not brick.** "Worth reading before you approve" is
                   what amber means; brick says it is broken. */
                skill.risk.map((r) => (
                  <span key={r} className="line warn">
                    <i />
                    {RISK_SAYS[r] ?? r}
                  </span>
                ))
              )}
            </div>
            {/* Where the drawing puts this fact — and, since it is a fact
                somebody may change, where the control for it goes too. */}
            <div className="facts-card">
              <h3>On by default</h3>
              <Defaults skill={skill} onChanged={onChanged} />
            </div>
          </aside>
        </div>
      )}

      <div className="max-w-[56rem]">
        {tab === "bundle" && <Bundle id={skill.id} />}
        {tab === "versions" && <Versions id={skill.id} />}
      </div>
      </>)}
    </section>
  );
}

/**
 * The review a held skill waits on. An agent wrote a version that ships a
 * script, so it is in the library but materialised nowhere — this is where the
 * owner reads exactly what would run and decides. Approve makes it the current
 * version; discard deletes it (and the skill too, if nothing was ever live).
 */
function Review({
  skill,
  onBack,
  onChanged,
}: {
  skill: Skill;
  onBack: () => void;
  onChanged: () => void;
}) {
  const q = useReviewSkill(skill.id);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      await approveSkill(skill.id);
      onChanged();
      onBack();
    } catch (e) {
      setErr(why(e));
      setBusy(false);
    }
  };
  const discard = async () => {
    const ok = await confirm({
      title: `Discard the pending ${skill.name}?`,
      body: "The version an agent wrote is deleted. If nothing of this skill was ever approved, the skill goes with it. Nothing that is running changes.",
      action: "Discard",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await discardSkill(skill.id);
      onChanged();
      onBack();
    } catch (e) {
      setErr(why(e));
      setBusy(false);
    }
  };

  /**
   * **Guarded.** This read `q.data` straight into `review.files.map(...)`, so
   * a review that had not arrived — or a request that failed — took the whole
   * screen down with `Cannot read properties of undefined`. A held skill is
   * exactly the row somebody clicks first, and `Boundary` catching it is not
   * the same as the screen working.
   */
  if (q.isPending) {
    return (
      <div className="max-w-[56rem] py-6">
        <p className="flex items-center gap-2 text-ui text-mute">
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
          Reading what the agent wrote…
        </p>
      </div>
    );
  }
  /* **Shape, not presence.** The thing that actually crashed was a server
     answering `[]` — truthy, so a `!q.data` guard passes it straight through
     to `review.files.map` and the screen goes down. The generated client does
     not validate at runtime, so the one field this screen cannot do without
     is checked here. */
  if (q.error || !Array.isArray((q.data as { files?: unknown } | undefined)?.files)) {
    return (
      <div className="max-w-[56rem] py-6">
        <Blank icon={TriangleAlert} title="That did not load">
          {q.error ? `${why(q.error)} ` : ""}The skill is still held — nothing has been approved and
          nothing has been discarded.
        </Blank>
      </div>
    );
  }

  const review = q.data;
  return (
    <div className="max-w-[56rem] py-6">
      <div className="rounded-xl border border-amber-deep bg-amber-tint/40 px-5 py-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber" strokeWidth={1.75} />
          <div className="min-w-0">
            <h2 className="text-ui font-medium text-bone">An agent wrote this, and it runs code</h2>
            <p className="mt-1 text-meta text-text">
              It ships a script that would be written onto the disk of every session that uses
              this skill, and run. Read it below, then approve it to make it live — or discard it.
              It runs nowhere until you approve it.
            </p>
          </div>
        </div>
      </div>

      {/* The three states are handled above, so this is the one that has
          something to draw. */}
      {(
        <div className="mt-5 space-y-4">
          <Facts
            title="What it says it is"
            rows={[
              ["Name", review.name],
              ["Does", review.description],
            ]}
          />
          <div className="space-y-3">
            {review.files.map((f) => (
              <div key={f.path} className="overflow-hidden rounded-lg border border-line bg-panel">
                <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
                  <span className="font-mono text-meta text-bone">{f.path}</span>
                  {f.executable && <Tag tone="brick">runs · 0o755</Tag>}
                  <span className="ml-auto text-micro tabular-nums text-mute">{size(f.size)}</span>
                </div>
                {f.text !== undefined ? (
                  <pre className="scroll-slim overflow-x-auto px-3 py-2.5 font-mono text-code leading-relaxed text-text">
                    {f.text}
                  </pre>
                ) : (
                  <p className="px-3 py-2.5 text-meta text-mute">Binary — {size(f.size)}, not shown.</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {err && <p className="mt-4 text-meta text-brick">{err}</p>}

      <div className="mt-5 flex items-center gap-2">
        <button
          onClick={approve}
          disabled={busy || q.isPending}
          className="control border border-sage-deep bg-sage-tint font-medium text-sage hover:bg-sage-deep/40 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" strokeWidth={2} />
          Approve &amp; enable
        </button>
        <button
          onClick={discard}
          disabled={busy}
          className="control border border-brick-deep text-brick hover:bg-brick-tint disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * On or off, drawn the way the platform draws one: a recessed track with a
 * raised knob that sits *inside* it.
 *
 * The knob is placed with `left`, in pixels, rather than translated from a
 * static position — an absolutely positioned child with no `left` resolves
 * against wherever the layout happened to put it, which is how the first
 * version ended up with the knob hanging off the right edge of its track.
 */
function Switch({ on, busy, onFlip }: { on: boolean; busy: boolean; onFlip: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-disabled={busy}
      onClick={() => {
        if (busy) return;
        onFlip();
      }}
      className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors ${
        on
          ? "border-sage-deep bg-sage-deep"
          : // A track that is only `bg-ground` on a near-black screen is
            // invisible — it read as empty space rather than as something off.
            "border-line bg-raise"
      }`}
    >
      <span
        // `translate` rather than animating `left`: a transitioned layout
        // property is laid out again every frame, which is the stutter this
        // had on the way across.
        style={{ transform: `translate(${on ? 14 : 2}px, -50%)` }}
        className={`absolute top-1/2 left-0 h-3 w-3 rounded-full transition-[transform,background-color] duration-150 ease-out ${
          on ? "bg-sage" : "bg-dim"
        } ${busy ? "opacity-60" : ""}`}
      />
    </button>
  );
}

/** A small table of facts, for the sidebar. */
function Facts({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="facts-card">
      <h3>{title}</h3>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Instructions({ id }: { id: string }) {
  const q = useSkillDetail(id);
  if (q.loading) return <p className="text-meta text-mute">Reading it off the server…</p>;
  if (!q.data) return null;
  return (
    <div className="prose-desk min-w-0 max-w-[80ch]">
      <Markdown>{q.data.body}</Markdown>
    </div>
  );
}

function Bundle({ id }: { id: string }) {
  const q = useSkillDetail(id);
  if (q.loading) return <p className="mt-4 text-meta text-mute">Reading it off the server…</p>;
  const files = q.data?.files ?? [];
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-line">
        {files.map((f) => (
          <div key={f.path} className="flex items-center gap-3 border-b border-line-soft px-3 py-1.5 last:border-b-0">
            <span className="min-w-0 flex-1 truncate font-mono text-code text-text">{f.path}</span>
            {f.shared && (
              <span className="shrink-0 text-micro text-sage" title="These bytes were already stored, under the same hash">
                shared
              </span>
            )}
            <span className="shrink-0 tabular-nums text-micro text-mute">{size(f.size)}</span>
          </div>
        ))}
      </div>
      <p className="max-w-prose border-l-2 border-line pl-3 text-meta leading-relaxed text-dim">
        Written into the session's own skills directory exactly as they arrived, and destroyed with the
        workspace. Every file is stored once under a hash of its contents, so two versions that share one
        share the bytes — and so do two people who dropped the same folder.
      </p>
    </div>
  );
}

function Versions({ id }: { id: string }) {
  const q = useSkillVersions(id);
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-line">
        {q.data.map((v, i) => (
          <div key={v.id} className="grid grid-cols-[42px_1fr_auto] gap-3 border-b border-line-soft px-3 py-2 last:border-b-0">
            <span className="tabular-nums text-meta font-mid text-bone">v{v.version}</span>
            <span className="min-w-0">
              <span className="block text-meta text-dim">{v.notes || "No note."}</span>
              <span className="mt-0.5 block text-micro text-mute">
                {v.author ?? "unknown"} · <span className="tabular-nums">{v.files}</span> files ·{" "}
                {size(v.bytes)}
              </span>
            </span>
            <span className="flex shrink-0 items-start gap-2">
              {i === 0 && <Tag>current</Tag>}
              {v.pinnedBy > 0 && <Tag>{v.pinnedBy} sessions on it</Tag>}
            </span>
          </div>
        ))}
      </div>
      <p className="max-w-prose border-l-2 border-slate-deep pl-3 text-meta leading-relaxed text-dim">
        <b className="font-mid text-bone">A new version is taken by whoever starts next.</b> A session
        already running keeps the version it pinned, because changing the instructions underneath a live
        conversation is the thing this avoids.
      </p>
    </div>
  );
}

function Defaults({ skill, onChanged }: { skill: Skill; onChanged: () => void }) {
  const repos = useRepos();
  const [busy, setBusy] = useState(false);

  const flip = async (repoId: string | null, on: boolean) => {
    setBusy(true);
    try {
      await setDefault(skill.id, { repoId: repoId ?? undefined, on });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(
    () => [
      {
        id: null as string | null,
        label: "In every workspace you start",
        on: skill.alwaysOn,
      },
      ...repos.data.map((r) => ({
        id: r.id as string | null,
        label: r.slug,
        on: skill.defaultIn.includes(r.slug),
      })),
    ],
    [repos.data, skill.alwaysOn, skill.defaultIn],
  );

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-line">
        {rows.map((r) => (
          <div key={r.id ?? "everywhere"} className="flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0">
            <span className={`min-w-0 flex-1 truncate text-meta text-text ${r.id ? "font-mono" : ""}`}>
              {r.label}
            </span>
            <Switch on={r.on} busy={busy} onFlip={() => flip(r.id, !r.on)} />
          </div>
        ))}
      </div>
      <p className="max-w-prose border-l-2 border-line pl-3 text-meta leading-relaxed text-dim">
        These are yours alone. Two people working on one repository already have their own row for it, with
        their own setup script, so nobody can set your defaults for you. Choose two repositories when
        starting work and you get the union of their defaults, already ticked and still removable before the
        first message.
      </p>
    </div>
  );
}
