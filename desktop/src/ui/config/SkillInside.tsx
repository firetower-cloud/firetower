/**
 * One skill, opened.
 *
 * **The body is the whole point.** A skill is a page of prose the agent reads
 * when the work matches, and until now there was nowhere to read it — the row
 * opened nothing at all, which is a dead click on the thing somebody is most
 * likely to be suspicious of. A marketplace that installs instructions you
 * cannot read is asking for trust it has not earned.
 */
import { ArrowLeft } from "lucide-react";
import { useSkillInside } from "~/api/generated/skills/skills";
import type { Item } from "~/api/generated/model";
import { Mark } from "~/ui/config/Library";

export function SkillInside({ of, onBack }: { of: Item; onBack: () => void }) {
  const inside = useSkillInside(of.skillId).data;
  /* The component's own path is the handle, so the right one is found even
     when a bundle carries eight of them. */
  const path = of.id.slice(of.skillId.length + 1);
  const mine = inside?.skills.find((s) => s.path === path);
  const siblings = (inside?.skills ?? [])
    .filter((s) => s.path !== path)
    .concat(inside?.commands ?? []);

  return (
    <div className="mx-auto w-full max-w-[920px] px-10 py-9">
      <button type="button" className="out" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        Skills &amp; MCP
      </button>

      <header className="mt-5 flex items-start gap-4 border-b border-line pb-5">
        <span className="shrink-0 origin-top-left scale-[1.6]">
          <Mark logo={of.logo} name={of.name} />
        </span>
        <div className="ml-6 min-w-0 flex-1">
          <h2 className="font-mono text-display text-bone">{of.name}</h2>
          <p className="mt-1 max-w-[70ch] text-ui text-dim">
            {mine?.description || of.description || "no description of its own"}
          </p>
        </div>
      </header>

      <div className="mt-6 grid grid-cols-[1fr_230px] gap-9 max-[900px]:grid-cols-1">
        <div className="min-w-0">
          <h3 className="text-ui text-dim">What it tells the agent</h3>
          <p className="mt-1 max-w-[74ch] text-meta text-dim">
            Read only when the description above matches the work, so a long one costs
            nothing until it is needed.
          </p>
          {/* Pre-wrapped rather than rendered: this is the file as it is on
              disk, and a screen that prettifies it is a screen you cannot
              check the bytes against. */}
          <pre className="mt-3 max-w-[80ch] overflow-x-auto whitespace-pre-wrap rounded-xl bg-raise p-4 font-mono text-meta leading-relaxed text-text">
            {mine?.body?.trim() || "This skill has no body — only its frontmatter."}
          </pre>

          {siblings.length > 0 && (
            <>
              <h3 className="mt-7 text-ui text-dim">
                Arrived with it{of.from ? `, in ${of.from}` : ""}
              </h3>
              <div className="mt-1">
                {siblings.map((c) => (
                  <div key={c.path} className="border-t border-line py-3 first:border-t-0">
                    <p className="font-mono text-ui text-bone">{c.name}</p>
                    <p className="mt-0.5 max-w-[70ch] text-meta text-dim">
                      {c.description || "no description of its own"}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-3 max-w-[74ch] text-meta text-dim">
                Removing any of these removes all of them — they are one folder. Switching
                one off is per item, and leaves the rest alone.
              </p>
            </>
          )}
        </div>

        <aside className="text-meta">
          <Fact label="Loaded">
            {of.required ? "Always — it cannot be turned off" : of.on ? "Into a plain agent of yours" : "Only when picked"}
          </Fact>
          {of.whyRequired && (
            <Fact label="Why">
              <span className="font-normal text-dim">{of.whyRequired}</span>
            </Fact>
          )}
          {of.from && <Fact label="Arrived with">{of.from}</Fact>}
          <Fact label="File">
            <span className="break-all font-mono text-dim">{path}</span>
          </Fact>
          {inside?.came && (
            <Fact label="Came from">
              {inside.came.marketplace}
              <br />
              <span className="font-mono text-mute">
                pinned {inside.came.commit.slice(0, 10)}
              </span>
            </Fact>
          )}
          {inside?.hasHooks && (
            <Fact label="Careful">
              <span className="text-ember">It ships hooks, which run commands</span>
            </Fact>
          )}
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line py-3 last:border-0">
      <p className="text-mute">{label}</p>
      <p className="mt-0.5 font-mid text-bone">{children}</p>
    </div>
  );
}
