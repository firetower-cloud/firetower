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
import { BACKENDS, STATE, setReach, emit, type BackendId } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { navigate } from "~/shims/next-navigation";
import { drag } from "~/drag";

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

export function StylePage() {
  useFixtures();

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
        <Remote />

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
            {BACKENDS.map((b) => (
              <div key={b.id} className="text-center">
                <span className="server-mark mx-auto grid h-8 w-8 place-items-center" data-on={b.id === "e1"} data-reach={b.reach}>
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

/** The prototype's remote: drive the states that are hard to catch by waiting. */
function Remote() {
  const fire = (id: BackendId) => {
    const s = STATE[id].find((x) => x.status === "Working") ?? STATE[id][0];
    s.status = "NeedsYou";
    s.note = "Fired from the style page. Does this land calmly?";
    s.updatedAt = new Date().toISOString();
    emit();
  };

  return (
    <div className="rounded-lg border border-line bg-raise p-4 shadow-(--shadow-raise)">
      <div className="eyebrow mb-2">Remote</div>
      <div className="flex flex-wrap gap-2">
        {BACKENDS.map((b) => (
          <div key={b.id} className="flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1">
            <span className="mr-1 text-meta text-dim">{b.org}</span>
            <Btn onClick={() => fire(b.id)}>ember</Btn>
            <Btn onClick={() => setReach(b.id, b.reach === "unreachable" ? "live" : "unreachable")}>
              {b.reach === "unreachable" ? "reconnect" : "drop"}
            </Btn>
            <Btn onClick={() => setReach(b.id, b.reach === "slow" ? "live" : "slow")}>
              {b.reach === "slow" ? "speed up" : "stall"}
            </Btn>
          </div>
        ))}
      </div>
    </div>
  );
}

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
