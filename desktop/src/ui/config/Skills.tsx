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
import { createPortal } from "react-dom";
import { ChevronLeft, FolderDown, Pencil, Plus, Search, X } from "lucide-react";
import { Rows, Section } from "~/ui/config/bits";
import { WhoCanAccess } from "~/ui/Sharing";
import { AddSkill } from "~/ui/AddSkill";
import { useSkills, useSkillDetail, useSkillVersions, why } from "~/data";
import { useRepos } from "~/data";
import { deleteSkill, setDefault } from "~/api/generated/skills/skills";
import { useQueryClient } from "@tanstack/react-query";
import { getListSkillsQueryKey } from "~/api/generated/skills/skills";
import type { Skill } from "~/api/generated/model";
import { useConfirm } from "~/ui/Confirm";
import { Markdown } from "~/components/Markdown";
import { readDrop, readFiles, size, RISK_SAYS, type Found } from "~/skills";

export function Skills() {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [over, setOver] = useState(false);
  /* A folder dropped on the list goes straight into the review, so the way in
     that the empty state describes is the way in that works. The entries are
     only readable while the event is being handled, so the read starts here
     and the promise is handed on. */
  const seed = useRef<ReturnType<typeof readDrop> | null>(null);
  const feed = useSkills();
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: getListSkillsQueryKey() });

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
    return <Detail skill={chosen} onBack={() => setOpen(null)} onChanged={refresh} onAdd={add} />;

  const q = query.trim().toLowerCase();
  const shown = q
    ? feed.data.filter(
        (s) =>
          s.name.includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.author ?? "").toLowerCase().includes(q),
      )
    : feed.data;

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
        <Empty over={over} onAdd={add} />
      </section>
    );

  return (
    <div {...surface} className={over ? "rounded-xl ring-1 ring-slate" : undefined}>
    <Section
      title="Skills"
      note="Folders of instructions an agent loads when it needs them. Yours stay in your own space until you file one into a directory."
      action={
        <button className="control border border-line bg-raise text-ui text-dim hover:bg-overlay hover:text-bone" onClick={() => add()}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          Add a skill
        </button>
      }
    >
      {feed.data.length > 6 && (
        <div className="flex items-center gap-2 px-3.5 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, description or author"
            className="min-w-0 flex-1 bg-transparent text-ui text-bone outline-none placeholder:text-mute"
          />
          <span className="shrink-0 text-micro tabular-nums text-mute">
            {shown.length} of {feed.data.length}
          </span>
        </div>
      )}
      <Rows feed={{ ...feed, data: shown }} empty={`No skill matches “${query}”.`}>
        {shown.map((s) => (
          <button
            key={s.id}
            onClick={() => setOpen(s.id)}
            className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-raise"
          >
            <Mark name={s.name} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="truncate font-mono text-ui text-bone">{s.name}</span>
                <span className="shrink-0 text-micro tabular-nums text-mute">v{s.version}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 block text-meta text-mute">{s.description}</span>
              <span className="mt-1.5 flex flex-wrap items-center gap-2">
                {s.author && <Tag>{s.author}</Tag>}
                <Tag>{s.tokens} tokens</Tag>
                {s.defaultIn.map((r) => (
                  <Tag key={r}>{r}</Tag>
                ))}
                {s.alwaysOn && <Tag>always on</Tag>}
                {s.risk.map((r) => (
                  <Tag key={r} tone="brick">
                    {r}
                  </Tag>
                ))}
              </span>
            </span>
            <span onClick={(e) => e.stopPropagation()} className="shrink-0">
              <WhoCanAccess look="chip" kind="skill" id={s.id} path={s.path} />
            </span>
          </button>
        ))}
      </Rows>
    </Section>
    </div>
  );
}

/**
 * Nothing here yet.
 *
 * An empty screen is an invitation to act: one button to choose a folder, and
 * the pane itself takes a drop.
 */
function Empty({ over, onAdd }: { over: boolean; onAdd: (d?: ReturnType<typeof readDrop>) => void }) {
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
      <h2 className="mt-3.5 text-lede text-bone">No skills yet</h2>
      <p className="mt-1.5 max-w-sm text-meta leading-relaxed text-mute">
        Import your skills by dropping one or many skills folders here.
      </p>
      <button
        onClick={() => picker.current?.click()}
        className="control mt-5 bg-overlay text-ui font-semibold text-bone shadow-raise hover:bg-[#26262c]"
      >
        Choose a folder
      </button>
      <p className="mt-4 text-micro text-mute">Or drop them here</p>
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
    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line bg-raise font-narrow text-micro font-bold uppercase text-dim shadow-raise">
      {letters}
    </span>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "brick" }) {
  return (
    <span
      className={`rounded-full border px-1.5 py-px text-micro ${
        tone === "brick" ? "border-brick-deep text-brick" : "border-line-soft text-mute"
      }`}
    >
      {children}
    </span>
  );
}

const TABS = [
  { at: "details", label: "Details" },
  { at: "bundle", label: "Bundle" },
  { at: "versions", label: "Versions" },
  { at: "defaults", label: "Defaults" },
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
  onAdd,
}: {
  skill: Skill;
  onBack: () => void;
  onChanged: () => void;
  onAdd: (d?: ReturnType<typeof readDrop>) => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["at"]>("details");
  const [saving, setSaving] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
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

  return (
    <section>
      <button onClick={onBack} className="flex items-center gap-1 text-meta text-mute hover:text-bone">
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        All skills
      </button>

      <div className="mt-3 flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-line bg-raise font-narrow text-title font-bold uppercase text-bone shadow-raise">
          {skill.name.split("-").slice(0, 2).map((w) => w[0] ?? "").join("")}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-display text-bone">{skill.name}</h2>
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-meta">
            <dt className="text-mute">Written by</dt>
            <dd className="text-text">{skill.author ?? "somebody who has left"}</dd>
            <dt className="text-mute">Costs</dt>
            <dd className="text-text">
              <span className="tabular-nums">{skill.tokens}</span> tokens of context, every turn
            </dd>
          </dl>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {skill.mayWrite && (
            <button className="control border border-line bg-raise text-ui text-dim hover:bg-overlay hover:text-bone" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
              Edit skill
            </button>
          )}
          <WhoCanAccess look="toolbar" kind="skill" id={skill.id} path={skill.path} />
        </div>
      </div>

      <div className="mt-4 track w-fit">
        {TABS.map((t) => (
          <button key={t.at} data-on={tab === t.at} onClick={() => setTab(t.at)}>
            {t.label}
          </button>
        ))}
      </div>

      {saving && <p className="mt-3 text-meta text-brick">{saving}</p>}

      {tab === "details" && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-meta text-dim">Description</span>
            <p className="max-w-prose text-ui leading-relaxed text-text">{skill.description}</p>
          </div>

          <div>
            <p className="text-meta text-dim">What it does to a session</p>
            <div className="mt-1.5 flex flex-col gap-1">
              {skill.risk.length === 0 ? (
                <span className="flex items-center gap-2 text-micro text-dim">
                  <span className="h-1.5 w-1.5 rounded-full bg-sage" />
                  Reads and instructs only
                </span>
              ) : (
                skill.risk.map((r) => (
                  <span key={r} className="flex items-center gap-2 text-micro text-dim">
                    <span className="h-1.5 w-1.5 rounded-full bg-brick" />
                    {RISK_SAYS[r] ?? r}
                  </span>
                ))
              )}
            </div>
            <p className="mt-1.5 max-w-prose text-micro leading-relaxed text-mute">
              Read from the bundle, not from what its author wrote. Firetower strips none of it, so this
              behaves here exactly as it does in Claude Code.
            </p>
          </div>

          <Instructions id={skill.id} />

          {skill.mayWrite && (
            <div className="flex justify-end border-t border-line-soft pt-3">
              <button className="control border border-brick-deep text-ui text-brick hover:bg-brick-tint" onClick={remove}>
                Delete
              </button>
            </div>
          )}
        </div>
      )}

      {editing && (
        <NewVersion
          skill={skill}
          onClose={() => setEditing(false)}
          onPicked={(d) => {
            setEditing(false);
            onAdd(d);
          }}
        />
      )}

      {tab === "bundle" && <Bundle id={skill.id} />}
      {tab === "versions" && <Versions id={skill.id} />}
      {tab === "defaults" && <Defaults skill={skill} onChanged={onChanged} />}
    </section>
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
      disabled={busy}
      onClick={onFlip}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-sage-deep" : "bg-ground shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)]"
      }`}
    >
      <span
        style={{ left: on ? 14 : 2 }}
        className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-[left,background-color] duration-150 ${
          on ? "bg-sage" : "bg-mute"
        }`}
      />
    </button>
  );
}

/**
 * Editing a skill is dropping its folder again. The window is mostly the
 * drop zone, because that is the whole instruction.
 */
function NewVersion({
  skill,
  onClose,
  onPicked,
}: {
  skill: Skill;
  onClose: () => void;
  onPicked: (d: ReturnType<typeof readDrop>) => void;
}) {
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-start justify-center bg-ground/50 pt-[16vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        className="w-[min(28rem,93vw)] overflow-hidden rounded-xl border border-line bg-overlay p-2 shadow-float"
      >
        <div className="flex items-center gap-2 px-3 pb-2 pt-2">
          <h2 className="min-w-0 truncate text-ui text-bone">
            Update <span className="font-mono">{skill.name}</span>
          </h2>
          <span className="rounded-full border border-line-soft px-1.5 py-px text-micro tabular-nums text-mute">
            v{skill.version} → v{skill.version + 1}
          </span>
          <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
        <div
          onDragOver={(e) => {
            if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            onPicked(readDrop(e.dataTransfer));
          }}
          className={`grid place-items-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors ${
            over ? "border-slate bg-slate-tint" : "border-line bg-panel/60"
          }`}
        >
          <span
            className={`grid h-11 w-11 place-items-center rounded-lg bg-raise shadow-raise transition-transform ${
              over ? "-translate-y-0.5 text-slate" : "text-mute"
            }`}
          >
            <FolderDown className="h-5 w-5" strokeWidth={1.75} />
          </span>
          <p className="mt-3.5 text-lede text-bone">{over ? "Let go to update" : "Drop the updated folder"}</p>
          <button
            autoFocus
            onClick={() => picker.current?.click()}
            className="control mt-4 bg-raise text-ui font-semibold text-bone shadow-raise hover:bg-[#26262c]"
          >
            Choose folder
          </button>
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          // @ts-expect-error — webkitdirectory is not in the DOM types
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={(e) => onPicked(readFiles(e.target.files))}
        />
      </div>
    </div>,
    document.body,
  );
}

function Instructions({ id }: { id: string }) {
  const q = useSkillDetail(id);
  if (q.loading) return <p className="text-meta text-mute">Reading it off the server…</p>;
  if (!q.data) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-meta text-dim">Instructions</span>
      <div className="prose-desk scroll-slim max-h-96 overflow-auto rounded-lg bg-ground px-4 py-1 shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)]">
        <Markdown>{q.data.body}</Markdown>
      </div>
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
            <span className="tabular-nums text-meta font-semibold text-bone">v{v.version}</span>
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
        <b className="font-semibold text-bone">A new version is taken by whoever starts next.</b> A session
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
      { id: null as string | null, label: "In every workspace you start", on: skill.alwaysOn },
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
