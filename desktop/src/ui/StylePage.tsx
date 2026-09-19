/**
 * The design system, rendered from its own tokens.
 *
 * Storybook's value at none of its cost, and it iterates in the same hot-reload
 * loop as the app. Two of these sections are new — `Servers` and `Reachability`
 * — and they are the first real extension to `globals.css` that the native,
 * multi-server client forces.
 *
 * It is also the prototype's remote control: knock a server offline, fire an
 * ember, and watch the inbox react.
 */
import { navigate } from "~/shims/next-navigation";
import { drag } from "~/drag";
import { Collapsed, Panel } from "~/island/Island";
import { islandState, modeOf } from "~/island/state";
import type { Fleet } from "~/fleet";
import type { Session } from "~/api/generated/model";

const GROUND = ["ground", "panel", "raise", "overlay", "line", "line-soft"];
const TEXT = [
  ["bone", "Titles, and the thing you are reading"],
  ["text", "Body — most of the words on screen"],
  ["dim", "Secondary: metadata, captions"],
  ["mute", "Furniture: counts, paths, placeholders"],
];
const TYPE = [
  ["display", "24px — the one heading on a page"],
  ["title", "16px — a row title, a card heading"],
  ["body", "14px — prose, a message"],
  ["ui", "13px — controls and labels"],
  ["meta", "11.5px — captions, counts, paths"],
  ["micro", "10.5px — eyebrows and column headers"],
];
const SIGNALS = [
  ["ember", "Something is waiting on you. Only ever this."],
  ["sage", "It worked"],
  ["brick", "It failed"],
  ["slate", "In flight, informational"],
];
const KINDS = ["source", "native", "data", "style", "media", "store", "prose"];
/** Three marks, for the sake of the drawing: selected, plain, and one that cannot be reached. */
const SERVERS = [
  { mark: "W", org: "Westlabs", user: "kevin", on: true, reach: "live" },
  { mark: "N", org: "Northwind", user: "kevin", on: false, reach: "live" },
  { mark: "P", org: "Parallax", user: "kp", on: false, reach: "unreachable" },
] as const;

export function StylePage() {
  return (
    <div className="scroll-slim h-full overflow-y-auto bg-ground">
      <header {...drag} className="sticky top-0 z-10 flex h-(--chrome-title) items-center gap-3 border-b border-line bg-panel px-4">
        <span className="eyebrow">Firetower — style</span>
        <button
          onClick={() => navigate("/")}
          className="no-drag ml-auto rounded-sm border border-line bg-raise px-2 py-1 text-meta text-text hover:bg-overlay"
        >
          Back to the app
        </button>
      </header>

      <div className="mx-auto max-w-[900px] space-y-10 p-8">
        <Section name="Ground" note="Six surfaces. Elevation is a colour change and a top highlight, never a box drawn around everything.">
          <div className="flex flex-wrap gap-3">
            {GROUND.map((g) => (
              <div key={g} className="w-[130px]">
                <div className={`h-14 rounded-md border border-line bg-${g}`} />
                <div className="mt-1.5 text-meta text-dim">--color-{g}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section name="Text" note="Four tiers with a real gap between each. Everything within one step of everything else is what makes a screen read as grey.">
          <div className="space-y-1.5 rounded-md border border-line bg-panel p-4">
            {TEXT.map(([c, label]) => (
              <p key={c} className={`text-body text-${c}`}>
                <span className="mr-3 font-mono text-meta text-mute">{c}</span>
                {label}
              </p>
            ))}
          </div>
        </Section>

        <Section name="Type" note="Six sizes, and a name for each. Anything that is not one of them is a mistake, and `just check-style` says so.">
          <div className="space-y-2 rounded-md border border-line bg-panel p-4">
            {TYPE.map(([t, label]) => (
              <div key={t} className="flex items-baseline gap-3">
                <span className="w-16 shrink-0 font-mono text-meta text-mute">{t}</span>
                <span className={`text-${t} text-bone`}>{label}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section name="Signal" note="Semantic only. Ember answers one question, and when it answered forty others it stopped answering that one.">
          <div className="grid grid-cols-2 gap-3">
            {SIGNALS.map(([c, label]) => (
              <div key={c} className={`rounded-md border border-${c}-deep bg-${c}-tint p-3`}>
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full bg-${c}`} />
                  <span className={`text-ui font-medium text-${c}`}>{c}</span>
                </div>
                <p className="mt-1 text-meta text-dim">{label}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section name="File kinds" note="What a file is, in the tree and nowhere else. Deliberately below the signals in saturation — four hundred rows must not out-shout the one that matters.">
          <div className="flex flex-wrap gap-2 rounded-md border border-line bg-panel p-4">
            {KINDS.map((k) => (
              <span key={k} className={`text-ui text-kind-${k}`}>
                ● {k}
              </span>
            ))}
          </div>
        </Section>

        <Section
          name="Servers"
          note="NEW. Identity is a shape, never a hue — the system already spends colour on signals and on file kinds, and a third namespace would compete with ember."
        >
          <div className="flex items-center gap-3 rounded-md border border-line bg-panel p-4">
            {SERVERS.map((b) => (
              <div key={b.mark} className="text-center">
                <span className="server-mark mx-auto grid h-8 w-8 place-items-center" data-on={b.on} data-reach={b.reach}>
                  {b.mark}
                </span>
                <div className="mt-1.5 text-meta text-dim">{b.org}</div>
                <div className="text-micro text-mute">{b.user}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          name="Reachability"
          note="NEW. The memo expects unreachable to be the common state. It is dimmed and dashed, never red — red is `brick` and means something failed; a server behind a VPN that is off has not failed."
        >
          <div className="flex gap-3 rounded-md border border-line bg-panel p-4">
            {(["live", "slow", "unreachable"] as const).map((r) => (
              <div key={r} className="text-center">
                <span className="server-mark mx-auto grid h-8 w-8 place-items-center" data-reach={r}>
                  W
                </span>
                <div className="mt-1.5 text-meta text-dim">{r}</div>
              </div>
            ))}
            <div className="ml-4 flex-1 border-l border-line-soft pl-4">
              <div className="eyebrow mb-1">Rows from a dark server</div>
              <div className="stale row" style={{ gridTemplateColumns: "18px 1fr auto" }}>
                <span className="text-micro font-bold text-mute">N</span>
                <span className="truncate text-ui text-dim">rate limits</span>
                <span className="text-meta text-mute">41m</span>
              </div>
              <p className="mt-1 text-meta text-mute">Stale, not gone. A list that empties itself reads as work being lost.</p>
            </div>
          </div>
        </Section>

        <Section name="Native" note="NEW. The macOS-only layer: a translucent rail over window vibrancy, and the drag regions that make the top of the window the window.">
          <div className="overflow-hidden rounded-md border border-line">
            <div className="flex h-9 items-center gap-2 bg-(--color-strip) px-3">
              <span className="h-3 w-3 rounded-full bg-brick" />
              <span className="h-3 w-3 rounded-full bg-[#d8a238]" />
              <span className="h-3 w-3 rounded-full bg-sage" />
              <span className="ml-3 text-meta text-mute">--chrome-title 38px · --chrome-lights 78px</span>
            </div>
            <div className="flex">
              <div className="h-20 w-12 bg-(--color-strip)" />
              <div className="h-20 w-[120px] bg-(--color-panel-vibrant)" />
              <div className="h-20 flex-1 bg-ground" />
            </div>
          </div>
        </Section>

        <Section
          name="Island"
          note="NEW. The pill above every other window. Three states and one action: it says whether anything is waiting on you, and it takes you there. Drawn here because the real one lives in its own window, where nobody looks at it until it is wrong — and because dormant and demand are otherwise hours apart."
        >
          <div className="flex flex-col items-start gap-4 rounded-md border border-line bg-ground p-5">
            {ISLANDS.map(([label, state]) => (
              <div key={label} className="flex items-center gap-4">
                <span className="w-[74px] shrink-0 text-meta text-mute">{label}</span>
                <div className="island-frame" data-perch="float">
                  <div className="island" data-mode={modeOf(state)} data-perch="float">
                    <div className="island-body">
                      <Collapsed state={state} mode={modeOf(state)} onGrab={() => {}} />
                    </div>
                  </div>
                </div>
              </div>
            ))}

            <div className="flex items-start gap-4">
              <span className="w-[74px] shrink-0 pt-2 text-meta text-mute">expanded</span>
              <div className="island-frame" data-perch="float">
                <div className="island" data-mode="demand" data-perch="float">
                  <div className="island-body">
                    <Panel state={ISLANDS[2][1]} mode="demand" onOpen={() => {}} onGrab={() => {}} />
                  </div>
                </div>
              </div>
            </div>

            {/* Drawn over a stand-in cutout, because the shape only makes
                sense against one: the gap in the middle is the notch, and the
                pill is split around it rather than over it. */}
            <div className="flex items-start gap-4">
              <span className="w-[74px] shrink-0 pt-2 text-meta text-mute">docked</span>
              <div className="relative">
                <div
                  className="absolute top-0 left-1/2 -translate-x-1/2 rounded-b-[10px] bg-black"
                  style={{ width: NOTCH.width, height: NOTCH.height }}
                  aria-hidden
                />
                <div className="island-frame relative" data-perch="notch">
                  <div className="island" data-mode="demand" data-perch="notch">
                    <div className="island-body">
                      <Collapsed
                        state={ISLANDS[2][1]}
                        mode="demand"
                        onGrab={() => {}}
                        gap={NOTCH.width}
                        tall={NOTCH.height}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section name="Motion" note="Native is quicker than web: 140ms where the web build uses 200ms, on the same curve. Ember-pulse is unchanged — it is the one thing allowed to be slow.">
          <div className="flex gap-4 rounded-md border border-line bg-panel p-4 text-meta text-dim">
            <span>--ease-swift cubic-bezier(0.16, 1, 0.3, 1)</span>
            <span>--dur-native 140ms</span>
          </div>
        </Section>
      </div>
    </div>
  );
}


/* Three fleets, for the sake of the drawing. The island's states are hours
   apart in real use — dormant first thing, ember at lunch — which is exactly
   the kind of thing the style page exists to put side by side. */
const stub = (over: Partial<Session>): Session =>
  ({
    id: "s_1",
    name: "auth middleware",
    agent: "ClaudeCode",
    repo: "westlabs/ledger",
    workspaceId: "w_1",
    createdAt: new Date(Date.now() - 28 * 60_000).toISOString(),
    ...over,
  }) as unknown as Session;

const backend = (mark: string) =>
  ({ id: mark, org: mark, user: "kevin", mark, url: "", reach: "live" }) as Fleet["backend"];

/** A 16-inch MacBook Pro's cutout, for the docked drawing. */
const NOTCH = { width: 200, height: 38 };

const ISLANDS: [string, ReturnType<typeof islandState>][] = [
  ["dormant", islandState([])],
  [
    "ambient",
    islandState([
      { backend: backend("W"), error: null, sessions: [stub({ status: "Working" })] },
    ]),
  ],
  [
    "demand",
    islandState([
      {
        backend: backend("W"),
        error: null,
        sessions: [
          stub({ status: "NeedsYou" }),
          stub({ id: "s_2", workspaceId: "w_2", name: "rate limiter", repo: "westlabs/api", agent: "Codex", status: "HandedBack", createdAt: new Date(Date.now() - 61 * 60_000).toISOString() }),
          stub({ id: "s_3", workspaceId: "w_3", name: "query optimisation", repo: "westlabs/web", status: "Working", createdAt: new Date(Date.now() - 300 * 60_000).toISOString() }),
        ],
      },
    ]),
  ],
];

function Btn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-sm border border-line bg-ground px-1.5 py-0.5 text-micro text-dim transition-colors hover:bg-overlay hover:text-bone"
    >
      {children}
    </button>
  );
}

function Section({ name, note, children }: { name: string; note: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-title text-bone">{name}</h2>
      <p className="mt-1 mb-3 max-w-[640px] text-meta text-dim">{note}</p>
      {children}
    </section>
  );
}
