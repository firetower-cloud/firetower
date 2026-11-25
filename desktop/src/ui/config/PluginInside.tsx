/**
 * What is in a plugin.
 *
 * **The screen a marketplace owes you.** Installing from a repository means
 * taking somebody else's instructions, and somebody else's MCP server, into
 * your agent's context. A library that offers that and gives you no way to
 * read it — before or after — is asking for trust it has not earned.
 *
 * So this is a reading screen, not a settings screen. It says what the bundle
 * carries in its author's own words, which address it will call, and where
 * the bytes came from. The one control is the one that is blocking.
 */
import { ArrowLeft, Link2, Puzzle, Terminal, TriangleAlert, Users } from "lucide-react";
import { useSkillInside } from "~/api/generated/skills/skills";
import type { Component, Skill } from "~/api/generated/model";
import { contents, Mark } from "~/ui/config/Plugins";

/** `685260eb0a82…` — enough to find the commit, short enough to read. */
function short(commit: string): string {
  return commit.slice(0, 10);
}

function Group({
  icon: Glyph,
  title,
  note,
  rows,
}: {
  icon: typeof Puzzle;
  title: string;
  note: string;
  rows: Component[];
}) {
  if (!rows.length) return null;
  return (
    <section className="mt-7">
      <h3 className="flex items-center gap-2 text-ui text-dim">
        <Glyph className="h-4 w-4" strokeWidth={1.5} />
        {title}
      </h3>
      <p className="mt-1 max-w-[74ch] text-meta text-dim">{note}</p>
      <div className="mt-2">
        {/* Not a `.r` row: that clamps its second line to one, and the
            sentence being clamped is the whole reason to open this screen —
            a skill's description is what decides whether the agent loads it. */}
        {rows.map((c) => (
          <div key={c.path} className="border-t border-line py-3 first:border-t-0">
            <p className="font-mono text-ui text-bone">{c.name}</p>
            <p className="mt-0.5 max-w-[74ch] text-meta text-dim">
              {c.description || "no description of its own"}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PluginInside({ of, onBack }: { of: Skill; onBack: () => void }) {
  const q = useSkillInside(of.id);
  const inside = q.data;
  const author =
    (inside?.manifest as { author?: { name?: string } } | null)?.author?.name ?? null;
  const version = (inside?.manifest as { version?: string } | null)?.version ?? null;

  return (
    <div className="mx-auto w-full max-w-[860px] px-10 py-9">
      <button type="button" className="out" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        Plugins
      </button>

      <header className="mt-5 flex items-start gap-4">
        <Mark of={of} />
        <div className="min-w-0 flex-1">
          <h2 className="text-display text-bone">{of.name}</h2>
          <p className="mt-1 max-w-[74ch] text-ui text-dim">{of.description}</p>
          <p className="mt-2 text-meta text-mute">
            {contents(of)}
            {author ? `, by ${author}` : ""}
            {version ? `, version ${version}` : ""}
          </p>
        </div>
      </header>

      {q.isLoading && <p className="mt-7 text-ui text-dim">Opening it…</p>}

      {inside?.came && (
        <section className="mt-7">
          <h3 className="text-ui text-dim">Where these bytes came from</h3>
          <p className="mt-1 max-w-[74ch] text-meta text-dim">
            A copy, taken once from{" "}
            <span className="font-mono text-bone">
              {inside.came.url.replace("https://github.com/", "")}
            </span>{" "}
            at <span className="font-mono text-bone">{short(inside.came.commit)}</span>. What
            that repository does afterwards cannot reach this copy.
          </p>
        </section>
      )}

      {inside?.url && (
        <section className="mt-7">
          <h3 className="flex items-center gap-2 text-ui text-dim">
            <Link2 className="h-4 w-4" strokeWidth={1.5} />
            The server it calls
          </h3>
          <p className="mt-1 max-w-[74ch] text-meta text-dim">
            The agent reaches these tools under the name{" "}
            <span className="font-mono text-bone">{inside.server}</span>.{" "}
            {inside.auth === "borrow-git"
              ? "It takes the credential Firetower already holds for your git host, so there is nothing to authorize."
              : inside.auth === "none"
                ? "It asks for no authorization at all."
                : "Your own authorization, held per person — a colleague connects separately."}
          </p>
          <p className="mt-2 break-all font-mono text-meta text-bone">{inside.url}</p>
        </section>
      )}

      <Group
        icon={Puzzle}
        title={`Skills (${inside?.skills.length ?? 0})`}
        note="Instructions the agent reads when the work matches. Each one costs context only when it is opened."
        rows={inside?.skills ?? []}
      />
      <Group
        icon={Terminal}
        title={`Commands (${inside?.commands.length ?? 0})`}
        note="Typed by a person as a slash command, never chosen by the model."
        rows={inside?.commands ?? []}
      />
      <Group
        icon={Users}
        title={`Subagents (${inside?.agents.length ?? 0})`}
        note="Agents this one can hand work to, with their own instructions."
        rows={inside?.agents ?? []}
      />

      {inside?.hasHooks && (
        <section className="mt-7">
          <h3 className="flex items-center gap-2 text-ui text-ember">
            <TriangleAlert className="h-4 w-4" strokeWidth={1.5} />
            It ships hooks
          </h3>
          <p className="mt-1 max-w-[74ch] text-meta text-dim">
            Hooks run commands on the machine around the agent&rsquo;s turns, without being
            asked each time. Read <span className="font-mono">hooks.json</span> below before
            turning this on anywhere that matters.
          </p>
        </section>
      )}

      {!!inside?.files.length && (
        <section className="mt-7">
          <h3 className="text-ui text-dim">Every file ({inside.files.length})</h3>
          <div className="mt-2">
            {inside.files.map((f) => (
              <div key={f.path} className="flex items-center gap-3 py-1">
                <span className="min-w-0 flex-1 truncate font-mono text-meta text-text">
                  {f.path}
                </span>
                <span className="shrink-0 text-meta text-mute">
                  {f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
