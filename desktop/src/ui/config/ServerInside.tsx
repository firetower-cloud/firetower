/**
 * One MCP server, opened.
 *
 * **The tools are the point, and they cannot be shown before you connect.**
 * Measured against Linear, Notion and Figma: all three refuse `tools/list`
 * without a token, because a server lists what it can do only to a client it
 * has authorized. So the section says so rather than guessing, and filling it
 * in becomes a reason to connect rather than a blank.
 *
 * **The right-hand column is what turns a row into something you can judge.**
 * Who made it, what signing in costs you, the address it will call, and —
 * the one line nobody else's catalogue can print — the exact commit the bytes
 * came from, because an install here is a pinned copy and not a subscription.
 */
import { useEffect } from "react";
import { ArrowLeft, Link2, Loader2, TriangleAlert } from "lucide-react";
import { useConnectorTools } from "~/api/generated/library/library";
import { useSkillInside } from "~/api/generated/skills/skills";
import { connect, useConnectorState } from "~/api/generated/connectors/connectors";
import { openExternal } from "~/open";
import { why } from "~/data";
import type { Item } from "~/api/generated/model";
import { Mark } from "~/ui/config/Library";
import { useState } from "react";

export function ServerInside({
  of,
  onBack,
  onGone,
}: {
  of: Item;
  onBack: () => void;
  onGone: () => Promise<void>;
}) {
  const inside = useSkillInside(of.skillId).data;
  const state = useConnectorState(of.skillId, {
    query: { refetchOnWindowFocus: true },
  }).data;
  const connected = !!state?.connected;
  const tools = useConnectorTools(of.skillId, { query: { enabled: connected } }).data;
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  /* Connecting happens elsewhere, so the page watches rather than waits. */
  useEffect(() => {
    if (connected) setBad(null);
  }, [connected]);

  const join = async () => {
    setBusy(true);
    setBad(null);
    try {
      const opened = await connect(of.skillId);
      await openExternal(opened.authorizeUrl);
    } catch (e) {
      setBad(why(e));
    } finally {
      setBusy(false);
    }
  };

  const others = (inside?.skills ?? []).concat(inside?.commands ?? []);

  return (
    <div className="mx-auto w-full max-w-[920px] px-10 py-9">
      <button type="button" className="out" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        Skills &amp; MCP
      </button>

      <header className="mt-5 flex items-start gap-4 border-b border-line pb-5">
        <span className="shrink-0 scale-[1.6] origin-top-left">
          <Mark logo={of.logo} name={of.name} />
        </span>
        <div className="ml-6 min-w-0 flex-1">
          <h2 className="text-display text-bone">{of.name}</h2>
          <p className="mt-1 max-w-[70ch] text-ui text-dim">{of.description}</p>
        </div>
        {of.connected === false && (
          <button type="button" className="btn primary shrink-0" disabled={busy} onClick={join}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
            ) : (
              <Link2 className="h-4 w-4" strokeWidth={1.5} />
            )}
            Connect
          </button>
        )}
      </header>

      {bad && <p className="mt-3 text-meta text-brick">{bad}</p>}

      <div className="mt-6 grid grid-cols-[1fr_230px] gap-9 max-[900px]:grid-cols-1">
        <div className="min-w-0">
          <p className="max-w-[68ch] text-ui leading-relaxed text-text">
            Tools from <b>{of.name}</b>, as an agent can call them.{" "}
            <b className="font-mid">Authorizing is per person</b>: a colleague connects their
            own account and sees exactly what {of.name} lets that account see — a better
            boundary than anything Firetower could enforce.
          </p>

          <h3 className="mt-7 text-ui text-dim">Tools</h3>
          {!connected ? (
            <div className="mt-2 rounded-xl border border-dashed border-line bg-raise p-3">
              <p className="max-w-[66ch] text-meta text-dim">
                <b className="text-bone">Connect to see what this server offers.</b> A server
                lists its tools only to a client it has authorized, so Firetower cannot show
                them before you connect — and will not guess.
              </p>
            </div>
          ) : tools?.names.length ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tools.names.map((t) => (
                <span
                  key={t}
                  className="rounded-md bg-sunk px-2 py-1 font-mono text-meta text-text"
                >
                  {t}
                </span>
              ))}
              <span className="self-center pl-1 text-meta text-mute">
                {tools.names.length} tools, as this server last listed them
              </span>
            </div>
          ) : (
            <p className="mt-2 text-meta text-dim">
              {tools?.why ?? "Asking the server…"}
            </p>
          )}

          {others.length > 0 && (
            <>
              <h3 className="mt-7 text-ui text-dim">Also brings</h3>
              <div className="mt-1">
                {others.map((c) => (
                  <div key={c.path} className="border-t border-line py-3 first:border-t-0">
                    <p className="font-mono text-ui text-bone">{c.name}</p>
                    <p className="mt-0.5 max-w-[70ch] text-meta text-dim">
                      {c.description || "no description of its own"}
                    </p>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mt-7 rounded-xl border-l-2 border-ember bg-raise py-3 pl-4 pr-4">
            <p className="flex items-center gap-2 text-ui text-bone">
              <TriangleAlert className="h-4 w-4 text-ember" strokeWidth={1.5} />
              Only add servers from people you trust.
            </p>
            <p className="mt-1 max-w-[72ch] text-meta text-dim">
              Firetower cannot verify which tools a server exposes, or that they will not
              change after you connect. The credential you grant is yours, and you can
              withdraw it from the &#8943; menu at any time.
            </p>
          </div>
        </div>

        <aside className="text-meta">
          <Fact label="Sign-in">
            {of.auth === "borrow-git"
              ? "Uses your git credential"
              : of.auth === "none"
                ? "Not required"
                : "Required, per person"}
          </Fact>
          <Fact label="Authorizing">
            {of.auth === "oauth" ? "OAuth, registered automatically" : of.auth ?? "—"}
          </Fact>
          <Fact label="Called as">
            <span className="font-mono">{of.server ?? of.name}</span>
          </Fact>
          <Fact label="Server">
            <span className="break-all font-mono text-dim">{of.url}</span>
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
          <Fact label="You">
            {of.connected === true
              ? "Connected"
              : of.connected === false
                ? "Not connected"
                : "Nothing to connect"}
          </Fact>
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
