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
import { SetUpClient } from "~/ui/config/SetUpClient";
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
  const [awaiting, setAwaiting] = useState(false);
  const state = useConnectorState(of.skillId, {
    query: { refetchOnWindowFocus: true, refetchInterval: awaiting ? 2000 : false },
  }).data;
  const connected = !!state?.connected;
  const tools = useConnectorTools(of.skillId, { query: { enabled: connected } }).data;
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);
  const [supplying, setSupplying] = useState(false);

  /* Connecting happens elsewhere, so the page watches rather than waits. */
  useEffect(() => {
    if (!connected) return;
    setBad(null);
    setAwaiting(false);
  }, [connected]);

  const join = async () => {
    // Known before it is attempted: installing records what the server said
    // about handing out clients, so a request made in order to be refused is
    // a spinner and an error where the form alone was the answer.
    if (of.needsClientId && !connected) {
      setSupplying(true);
      return;
    }
    setBusy(true);
    setBad(null);
    try {
      const opened = await connect(of.skillId);
      await openExternal(opened.authorizeUrl);
      setAwaiting(true);
    } catch (e) {
      // A server that advertises registration and then refuses it cannot be
      // known in advance; that one still finds out by trying.
      if ((e as { code?: string })?.code === "ConnectorNeedsClient") setSupplying(true);
      else setBad(why(e));
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
          <Mark logo={of.logo} name={of.displayName} />
        </span>
        <div className="ml-6 min-w-0 flex-1">
          <h2 className="text-display text-bone">{of.displayName}</h2>
          <p className="mt-1 max-w-[70ch] text-ui text-dim">{of.description}</p>
        </div>
        {/* **Live, not the snapshot the list arrived with.** This read
            `of.connected`, which is whatever the library said when the page
            before it was fetched — so a server connected a moment ago still
            offered a Connect button here. `useConnectorState` asks for
            itself and refetches when the window comes forward. */}
        {of.needsClientId && !connected ? (
          <button
            type="button"
            className="btn primary shrink-0"
            onClick={() => setSupplying((v) => !v)}
          >
            Set it up
          </button>
        ) : of.connected !== null && !connected ? (
          <button type="button" className="btn primary shrink-0" disabled={busy} onClick={join}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
            ) : (
              <Link2 className="h-4 w-4" strokeWidth={1.5} />
            )}
            Connect
          </button>
        ) : null}
      </header>

      {/* **The other side of the wall.** A server that registers no clients
          could be added and never used: Connect had nothing to send, the row
          said so, and that was the end of it. GitHub, Slack and Google are
          all here — between them most of what anybody wants to connect — so
          "not supported yet" was most of the product missing.

          One application for this whole Firetower, not one per person: the
          people who connect afterwards each authorize their own account
          through it. */}
      {/* **The same component the row opens in a modal.** Two copies of a
          form is two forms that drift, and this one carries the redirect
          address and the scope list — the two things that are wrong in a way
          nobody can see. */}
      {supplying && (
        <section className="mt-5 rounded-xl bg-raise p-4">
          <h3 className="text-ui text-bone">An application for {of.displayName}</h3>
          <div className="mt-1">
            <SetUpClient
              of={{
                skillId: of.skillId,
                displayName: of.displayName,
                console: of.console,
                guide: of.guide,
              }}
              onCancel={() => setSupplying(false)}
              onDone={async () => {
                setSupplying(false);
                await onGone();
                await join();
              }}
            />
          </div>
        </section>
      )}

      {bad && <p className="mt-3 text-meta text-brick">{bad}</p>}

      <div className="mt-6 grid grid-cols-[1fr_230px] gap-9 max-[900px]:grid-cols-1">
        <div className="min-w-0">
          <p className="max-w-[68ch] text-ui leading-relaxed text-text">
            Tools from <b>{of.displayName}</b>, as an agent can call them.{" "}
            <b className="font-mid">Authorizing is per person</b>: a colleague connects their
            own account and sees exactly what {of.displayName} lets that account see — a better
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
            {of.auth === "none" ? "Not required" : "Required, per person"}
          </Fact>
          <Fact label="Authorizing">
            {of.needsClientId
              ? "OAuth, with an application you supply"
              : of.auth === "oauth"
                ? "OAuth, registered automatically"
                : (of.auth ?? "—")}
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
            {of.connected === null
              ? "Nothing to connect"
              : connected
                ? "Connected"
                : "Not connected"}
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
