/**
 * One catalogue entry, opened before anybody installs it.
 *
 * **Read before you agree, not after.** A card says how many skills an entry
 * brings; it cannot say what they tell an agent to do, and until this existed
 * the only way to read a stranger's instructions was to install them first.
 * The files are pulled at the pinned commit for this screen and thrown away —
 * nothing is stored until Add is pressed.
 */
import { ArrowLeft, Loader2, Plus, TriangleAlert } from "lucide-react";
import { usePreviewEntry } from "~/api/generated/marketplaces/marketplaces";
import type { Listed } from "~/api/generated/model";
import { Mark } from "~/ui/config/Library";

export function OfferInside({
  of,
  busy,
  onBack,
  onAdd,
}: {
  of: Listed;
  busy: boolean;
  onBack: () => void;
  onAdd: () => void;
}) {
  const q = usePreviewEntry(of.marketplaceId, of.slug);
  const seen = q.data;

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
          <h2 className="text-display text-bone">{of.name}</h2>
          <p className="mt-1 max-w-[70ch] text-ui text-dim">{of.description}</p>
        </div>
        <button type="button" className="btn primary shrink-0" disabled={busy} onClick={onAdd}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
          ) : (
            <Plus className="h-4 w-4" strokeWidth={1.75} />
          )}
          Add
        </button>
      </header>

      <div className="mt-6 grid grid-cols-[1fr_230px] gap-9 max-[900px]:grid-cols-1">
        <div className="min-w-0">
          {q.isLoading && <p className="text-ui text-dim">Opening it…</p>}
          {q.error && (
            <p className="max-w-[70ch] text-ui text-dim">
              That entry could not be read from its repository just now.
            </p>
          )}

          {seen?.url && (
            <>
              <h3 className="text-ui text-dim">The server it would call</h3>
              <p className="mt-1 break-all font-mono text-meta text-bone">{seen.url}</p>
              <p className="mt-1 max-w-[70ch] text-meta text-dim">
                Adding it does not authorize it. You connect afterwards, as yourself.
              </p>
            </>
          )}

          {seen?.skills.map((c) => (
            <section key={c.path} className="mt-7">
              <h3 className="font-mono text-ui text-bone">{c.name}</h3>
              <p className="mt-0.5 max-w-[74ch] text-meta text-dim">{c.description}</p>
              {/* The file as it is in the repository. A screen that tidies it
                  is one you cannot check the bytes against. */}
              <pre className="mt-2 max-w-[80ch] overflow-x-auto whitespace-pre-wrap rounded-xl bg-raise p-4 font-mono text-meta leading-relaxed text-text">
                {c.body?.trim() || "No body — only frontmatter."}
              </pre>
            </section>
          ))}

          {!!seen?.commands.length && (
            <section className="mt-7">
              <h3 className="text-ui text-dim">Commands</h3>
              <div className="mt-1">
                {seen.commands.map((c) => (
                  <div key={c.path} className="border-t border-line py-3 first:border-t-0">
                    <p className="font-mono text-ui text-bone">{c.name}</p>
                    <p className="mt-0.5 max-w-[70ch] text-meta text-dim">{c.description}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {seen?.hasHooks && (
            <section className="mt-7 rounded-xl border-l-2 border-ember bg-raise py-3 pl-4 pr-4">
              <p className="flex items-center gap-2 text-ui text-bone">
                <TriangleAlert className="h-4 w-4 text-ember" strokeWidth={1.5} />
                It ships hooks
              </p>
              <p className="mt-1 max-w-[72ch] text-meta text-dim">
                Hooks run commands on the machine around an agent&rsquo;s turns, without being
                asked each time. Read <span className="font-mono">hooks.json</span> below
                before adding this anywhere that matters.
              </p>
            </section>
          )}

          {!!seen?.files.length && (
            <section className="mt-7">
              <h3 className="text-ui text-dim">Every file ({seen.files.length})</h3>
              <div className="mt-2">
                {seen.files.map((f) => (
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

        <aside className="text-meta">
          {of.author && <Fact label="By">{of.author}</Fact>}
          {of.category && <Fact label="Category">{of.category}</Fact>}
          {of.version && <Fact label="Version">{of.version}</Fact>}
          <Fact label="From">
            {of.marketplaceName}
            <br />
            <span className="font-normal text-mute">not installed</span>
          </Fact>
          {of.homepage && (
            <Fact label="Home">
              <span className="break-all font-normal text-dim">{of.homepage}</span>
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
