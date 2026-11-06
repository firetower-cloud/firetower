/**
 * The design system, rendered from its own tokens.
 *
 * Storybook's value at none of its cost, and it iterates in the same hot-reload
 * loop as the app. It is also the prototype's remote control: flip the theme at
 * the top and every swatch, every tint and every syntax colour on the page
 * re-resolves, which is the fastest way there is to find a token that has a
 * dark value and no light one.
 *
 * **Keep it ahead of the app, not behind it.** Three sets here — the chart
 * series, the syntax palette and the amber pair — exist on this page before
 * they exist on a screen, because a colour nobody has looked at is a colour
 * nobody has checked.
 */
import { navigate } from "~/shims/next-navigation";
import { drag } from "~/drag";
import { Collapsed, Panel } from "~/island/Island";
import { islandState, modeOf } from "~/island/state";
import type { Fleet } from "~/fleet";
import type { Session } from "~/api/generated/model";
import { marksOf } from "~/fleet";
import { useTheme, type Theme } from "~/theme";

/**
 * Every class on this page is written out, never interpolated.
 *
 * Tailwind scans source *text* for candidates: `text-kind-${k}` is not one,
 * so a swatch built that way draws in whatever colour it inherits and looks
 * plausible. Two of the file kinds on this page were doing exactly that —
 * `media` and `store` have never had a swatch, only a word in the right
 * place. **A check that cannot fail is worse than no check**, and a style page
 * that cannot show a missing colour is that check.
 */
const GROUND: [string, string][] = [
  ["ground", "bg-ground"],
  ["panel", "bg-panel"],
  ["raise", "bg-raise"],
  ["overlay", "bg-overlay"],
  ["line", "bg-line"],
  ["line-soft", "bg-line-soft"],
];
const TEXT: [string, string, string][] = [
  ["bone", "text-bone", "Titles, and the thing you are reading"],
  ["text", "text-text", "Body — most of the words on screen"],
  ["dim", "text-dim", "Secondary: metadata, captions"],
  ["mute", "text-mute", "Furniture: counts, paths, placeholders"],
];
const TYPE: [string, string, string][] = [
  ["display", "text-display", "28px — the one heading on a page"],
  ["title", "text-title", "17px — a row title, a card heading"],
  ["lede", "text-lede", "17px — a first line worth slowing for"],
  ["read", "text-read", "15px — the conversation"],
  ["body", "text-body", "14px — prose, a message"],
  ["ui", "text-ui", "13.5px — controls and labels"],
  ["meta", "text-meta", "12px — captions, counts, paths"],
  ["micro", "text-micro", "11px — column headers, a line-number gutter"],
];
/** name · the badge · the dot · the label · what it means */
const SIGNALS: [string, string, string, string, string][] = [
  ["ember", "border-ember-deep bg-ember-tint", "bg-ember", "text-ember-ink", "An agent is waiting on you. Only ever this."],
  ["sage", "border-sage-deep bg-sage-tint", "bg-sage", "text-sage", "It worked"],
  ["brick", "border-brick-deep bg-brick-tint", "bg-brick", "text-brick", "It failed"],
  ["amber", "border-amber-deep bg-amber-tint", "bg-amber-soft", "text-amber", "Still working, but not for much longer"],
  ["slate", "border-slate-deep bg-slate-tint", "bg-slate", "text-slate", "In flight, informational"],
];
const KINDS: [string, string][] = [
  ["source", "text-kind-source"],
  ["native", "text-kind-native"],
  ["data", "text-kind-data"],
  ["style", "text-kind-style"],
  ["media", "text-kind-media"],
  ["store", "text-kind-store"],
  ["prose", "text-kind-prose"],
];
const SERIES: [string, string][] = [
  ["series-1", "bg-series-1"],
  ["series-2", "bg-series-2"],
  ["series-3", "bg-series-3"],
  ["series-4", "bg-series-4"],
];
const SYNTAX: [string, string][] = [
  ["comment", "text-syn-comment"],
  ["string", "text-syn-string"],
  ["keyword", "text-syn-keyword"],
  ["type", "text-syn-type"],
  ["number", "text-syn-number"],
  ["fn", "text-syn-fn"],
  ["attr", "text-syn-attr"],
];
/** Four organisations, two of which share a first letter. See `markOf`. */
const ORGS = ["Westlabs", "Acme", "Apex", "Parallax"];

export function StylePage() {
  const [choice, resolved, setChoice] = useTheme();
  const marks = marksOf(ORGS);

  return (
    <div className="scroll-slim h-full w-full overflow-y-auto bg-ground">
      <header {...drag} className="sticky top-0 z-10 flex h-(--chrome-title) items-center gap-3 border-b border-line bg-panel px-4">
        <span className="text-ui font-medium text-bone">Firetower — style</span>
        <span className="track no-drag ml-auto">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <button key={t} data-on={choice === t} onClick={() => setChoice(t)} className="capitalize">
              {t}
            </button>
          ))}
        </span>
        <span className="text-meta text-mute">{resolved}</span>
        <button
          onClick={() => navigate("/")}
          className="no-drag rounded-md border border-line bg-raise px-2 py-1 text-meta text-text hover:bg-overlay"
        >
          Back to the app
        </button>
      </header>

      <div className="mx-auto max-w-[900px] space-y-10 p-8">
        <Section name="Ground" note="Six surfaces. In dark, elevation is a colour change and a top highlight; in light it is a soft drop and a hairline ring, because a white highlight over a pale ground says nothing at all.">
          <div className="flex flex-wrap gap-3">
            {GROUND.map(([name, fill]) => (
              <div key={name} className="w-[130px]">
                <div className={`h-14 rounded-md border border-line ${fill}`} />
                <div className="mt-1.5 text-meta text-dim">--color-{name}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section name="Text" note="Four tiers with a real gap between each. Everything within one step of everything else is what makes a screen read as grey.">
          <div className="space-y-1.5 rounded-md border border-line bg-panel p-4">
            {TEXT.map(([name, tone, label]) => (
              <p key={name} className={`text-body ${tone}`}>
                <span className="mr-3 font-mono text-meta text-mute">{name}</span>
                {label}
              </p>
            ))}
          </div>
        </Section>

        <Section name="Type" note="Sizes with a name each. Anything that is not one of them is a mistake, and `just check-style` says so — including in `desktop/src`, which it did not look at until now.">
          <div className="space-y-2 rounded-md border border-line bg-panel p-4">
            {TYPE.map(([name, size, label]) => (
              <div key={name} className="flex items-baseline gap-3">
                <span className="w-16 shrink-0 font-mono text-meta text-mute">{name}</span>
                <span className={`${size} text-bone`}>{label}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section name="Signal" note="Semantic only, and each is composed the same way in both themes: the colour on its tint, inside its deep. That is why a light value is derived against the neighbour it sits on rather than against the page — measuring amber against white produced a value that was technically fine and visually wrong.">
          <div className="grid grid-cols-2 gap-3">
            {SIGNALS.map(([name, badge, dot, ink, label]) => (
              <div key={name} className={`rounded-md border p-3 ${badge}`}>
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${dot}`} />
                  <span className={`text-ui font-medium ${ink}`}>{name}</span>
                </div>
                <p className="mt-1 text-meta text-dim">{label}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section
          name="The two steps a light ground needs"
          note="`-soft` is the lighter of a pair in either theme, and a token that is text on its own tint in light needs an `-ink` step. The roles swap between the two namespaces because text on a dark tint has to be the lighter value and text on a pale tint the darker one — and both rows below are correct in both themes without a call site changing."
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-line bg-panel p-3">
              <p className="text-ui text-bone">Amber</p>
              <p className="mt-2 inline-flex rounded-md border border-amber-deep bg-amber-tint px-2 py-1 text-meta text-amber">
                --color-amber, on its own tint
              </p>
              <p className="mt-2 flex items-center gap-2 text-meta text-dim">
                <span className="h-2 w-2 rounded-full bg-amber-soft" />
                --color-amber-soft, a mark on the page
              </p>
            </div>
            <div className="rounded-md border border-line bg-panel p-3">
              <p className="text-ui text-bone">Ember</p>
              <p className="mt-2 inline-flex rounded-md border border-ember-deep bg-ember-tint px-2 py-1 text-meta text-ember-ink">
                --color-ember-ink, on its own tint
              </p>
              <p className="mt-2 flex items-center gap-2 text-meta text-dim">
                <span className="h-2 w-2 rounded-full bg-ember" />
                --color-ember, the one saturated thing there is
              </p>
            </div>
          </div>
        </Section>

        <Section name="File kinds" note="What a file is, in the tree and nowhere else. Deliberately below the signals in saturation — four hundred rows must not out-shout the one that matters. Light holds 5.7:1 on white, which is what the dark set's weakest member holds on the panel.">
          <div className="flex flex-wrap gap-3 rounded-md border border-line bg-panel p-4">
            {KINDS.map(([name, tone]) => (
              <span key={name} className={`text-ui ${tone}`}>
                ● {name}
              </span>
            ))}
          </div>
        </Section>

        <Section name="Chart series" note="One hue per model, and the only place data wears colour. Ember is absent on purpose. Tritanopic separation of adjacent members is weak in both themes, so a series is directly labelled and never keyed by colour alone.">
          <div className="flex gap-3 rounded-md border border-line bg-panel p-4">
            {SERIES.map(([name, fill]) => (
              <div key={name} className="flex-1">
                <div className={`h-10 rounded-sm ${fill}`} />
                <div className="mt-1.5 text-meta text-dim">{name}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          name="Syntax"
          note="Seven colours, in `styles.css` rather than `globals.css`, which is why they were missed the first time light was derived. The rule here is different from the file kinds: each matches its own dark ratio rather than a common floor, because in this set the ratios are the design — comment is deliberately the faintest thing on the page."
        >
          <pre className="ft-pre overflow-x-auto rounded-md border border-line bg-panel p-4 font-mono text-code">
            <span className="text-syn-comment">{"// Where amber begins, or None when it never does."}</span>
            {"\n"}
            <span className="text-syn-attr">{"#[derive(Debug)]"}</span>
            {"\n"}
            <span className="text-syn-keyword">pub fn </span>
            <span className="text-syn-fn">amber_at</span>
            <span className="text-text">{"(&"}</span>
            <span className="text-syn-keyword">self</span>
            <span className="text-text">{") -> "}</span>
            <span className="text-syn-type">Option</span>
            <span className="text-text">{"<"}</span>
            <span className="text-syn-type">u64</span>
            <span className="text-text">{"> {"}</span>
            {"\n    "}
            <span className="text-syn-keyword">let </span>
            <span className="text-text">soft = </span>
            <span className="text-syn-string">&quot;soft&quot;</span>
            <span className="text-text">; soft * </span>
            <span className="text-syn-number">80</span>
            <span className="text-text"> / </span>
            <span className="text-syn-number">100</span>
            {"\n"}
            <span className="text-text">{"}"}</span>
          </pre>
          <div className="mt-2 flex flex-wrap gap-3">
            {SYNTAX.map(([name, tone]) => (
              <span key={name} className={`text-meta ${tone}`}>
                ● syn-{name}
              </span>
            ))}
          </div>
        </Section>

        <Section
          name="Firetower marks"
          note="Identity is a shape, never a hue — a colour-coded server is unreadable to a dichromat and collides with the signal palette. Two letters rather than one: this was `org.slice(0, 1)`, so Acme and Apex were both “A”. Derived from the organisation's name and nothing else, so connecting a Firetower never re-letters one you already had — a mark you cannot learn is not a mark."
        >
          <div className="flex items-center gap-5 rounded-md border border-line bg-panel p-4">
            {ORGS.map((org, i) => (
              <div key={org} className="text-center">
                <span
                  className="server-mark mx-auto grid h-8 w-8 place-items-center"
                  data-on={i === 0}
                  data-reach={i === 3 ? "unreachable" : "live"}
                >
                  {marks[i]}
                </span>
                <div className="mt-1.5 text-meta text-dim">{org}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          name="Reachability"
          note="The memo expects unreachable to be the common state. It is dimmed and dashed, never red — red is `brick` and means something failed; a Firetower behind a VPN that is off has not failed, and its rows stay with what was last known on them."
        >
          <div className="flex gap-3 rounded-md border border-line bg-panel p-4">
            {(["live", "unreachable"] as const).map((r) => (
              <div key={r} className="text-center">
                <span className="server-mark mx-auto grid h-8 w-8 place-items-center" data-reach={r}>
                  We
                </span>
                <div className="mt-1.5 text-meta text-dim">{r}</div>
              </div>
            ))}
            <div className="ml-4 flex-1 border-l border-line-soft pl-4">
              <p className="mb-1 text-meta text-dim">Rows from a dark Firetower</p>
              <div className="stale prow">
                <span className="min-w-0 flex-1 truncate">rate limits</span>
                <span className="text-meta text-dim">41m</span>
              </div>
              <p className="mt-1 text-meta text-mute">Stale, not gone. A list that empties itself reads as work being lost.</p>
            </div>
          </div>
        </Section>

        <Section
          name="The shell"
          note="A 62px rail, a 252px panel, an 8px gutter and the sheet — flush right and bottom, rounded only on the side that faces the chrome. The selected destination is a pill in the sheet's own colour, because it is the sheet's handle."
        >
          <div className="overflow-hidden rounded-md border border-line">
            <div className="flex h-(--chrome-title) items-center gap-2.5 bg-ground px-3">
              <span className="server-mark grid h-5 w-5 place-items-center text-micro" data-reach="live">
                We
              </span>
              <span className="text-ui font-medium text-bone">Westlabs</span>
              <span className="text-ui text-line">/</span>
              <span className="text-ui text-mute">kevin</span>
            </div>
            <div className="flex h-[150px] bg-ground">
              <div className="flex w-(--rail) flex-col items-center gap-1 pt-0.5">
                <span className="rbtn" aria-current="page">
                  <span className="h-4 w-4 rounded-sm bg-current opacity-70" />
                </span>
                <span className="rbtn">
                  <span className="h-4 w-4 rounded-sm bg-current opacity-30" />
                </span>
                <span className="rbtn" data-peek="true">
                  <span className="h-4 w-4 rounded-sm bg-current opacity-30" />
                </span>
              </div>
              <div className="flex w-(--panel) flex-col gap-0.5 px-2 pt-2">
                <span className="prow" aria-current="true">
                  <span className="flex-1 truncate">Quota meter rounding</span>
                  <span className="text-meta text-dim">12m</span>
                </span>
                <span className="prow">
                  <span className="flex-1 truncate">Backfill the invoice index</span>
                  <span className="text-meta text-dim">3h</span>
                </span>
              </div>
              <div className="ml-2 flex-1 rounded-tl-sheet bg-panel shadow-(--shadow-raise)" />
            </div>
          </div>
        </Section>

        <Section
          name="Island"
          note="The pill above every other window. Three states and one action: it says whether anything is waiting on you, and it takes you there. **It is deliberately outside this design** — the pill is the black the notch is made of in any appearance, it is the one place ember is decoration rather than a signal, and it keeps the two ALL-CAPS labels the rest of the app no longer has. It has its own window, its own rules and a document still to be written; drawn here so it is looked at at all."
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
                  className="absolute top-0 left-1/2 -translate-x-1/2 rounded-b-lg bg-black"
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

        <Section name="Motion" note="One curve everywhere. Native is quicker than web: 140ms where the web build uses 200ms. Under `prefers-reduced-motion` every duration collapses; under `prefers-reduced-transparency` the floating panel goes opaque and drops its blur.">
          <div className="flex gap-4 rounded-md border border-line bg-panel p-4 text-meta text-dim">
            <span>--ease-swift cubic-bezier(0.16, 1, 0.3, 1)</span>
            <span>--dur-native 140ms</span>
            <span>--dur-island 320ms</span>
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

function Section({ name, note, children }: { name: string; note: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-title text-bone">{name}</h2>
      <p className="mt-1 mb-3 max-w-[640px] text-meta text-dim">{note}</p>
      {children}
    </section>
  );
}
