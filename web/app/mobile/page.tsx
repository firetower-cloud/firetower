import { Mark, Signal } from "@/components/Signal";
import { Bullet } from "@/components/Terminal";
import { byId, working, elapsed } from "@/lib/data";

const nav = byId("t-104")!;
const stripe = byId("t-101")!;
const idem = byId("t-099")!;

export default function Mobile() {
  return (
    <div className="px-8 pt-8 pb-24">
      <header className="mb-8 max-w-[620px]">
        <div className="eyebrow">On your phone</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          Buzz to unblocked in three taps.
        </h1>
        <p className="mt-1.5 text-[14px] text-dim">
          The one path worth optimising. An agent stops without you, your phone buzzes, you answer
          in a sentence, and it keeps going.
        </p>
      </header>

      <div className="flex flex-wrap gap-6">
        <Frame caption="Only three transitions ever notify — waiting, finished, failed. All three mean the agent stopped being useful without you, so the buzz is always true.">
          <LockScreen />
        </Frame>

        <Frame caption="Same inbox as the desktop, same order. What needs you is fat and answerable; what's working is a one-line heartbeat you can ignore.">
          <Inbox />
        </Frame>

        <Frame caption="The question is pulled out of the PTY and rendered as text. An 80×24 ANSI grid is the wrong interface for answering 'yes' at dinner — but the real terminal stays one tap away.">
          <Reply />
        </Frame>

        <Frame caption="When you do need the terminal, it comes with the keys a phone keyboard doesn't have. Without ⌃C and Esc, xterm.js on a phone is decoration.">
          <PhoneTerminal />
        </Frame>
      </div>
    </div>
  );
}

function Frame({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    <figure className="w-[264px]">
      <div className="relative h-[560px] overflow-hidden rounded-[28px] border border-line bg-ground p-[6px] shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)]">
        <div className="relative h-full overflow-hidden rounded-[24px] bg-ground">{children}</div>
      </div>
      <figcaption className="mt-3 text-[12px] leading-[1.55] text-mute">{caption}</figcaption>
    </figure>
  );
}

function StatusBar({ dark }: { dark?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between px-5 pt-3 pb-1 font-mono text-[10.5px] ${
        dark ? "text-bone/80" : "text-mute"
      }`}
    >
      <span>20:41</span>
      <span className="tracking-[0.1em]">▮▮▮ ▲ ▰</span>
    </div>
  );
}

function LockScreen() {
  return (
    <div className="relative flex h-full flex-col bg-[#080706]">
      <div
        className="absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(120% 70% at 50% 100%, #2a1608 0%, #140d07 45%, #080706 78%)",
        }}
      />
      <svg
        className="absolute inset-x-0 bottom-0 h-[150px] w-full opacity-90"
        viewBox="0 0 300 150"
        preserveAspectRatio="none"
        aria-hidden
      >
        <path d="M0 96 L52 70 L96 88 L140 56 L188 84 L232 62 L272 90 L300 76 V150 H0 Z" fill="#120e0a" />
        <path d="M0 118 L44 104 L92 116 L138 98 L186 114 L236 100 L280 118 L300 110 V150 H0 Z" fill="#0b0908" />
      </svg>

      <div className="relative">
        <StatusBar dark />
        <div className="pt-10 text-center">
          <div className="font-mono text-[13px] tracking-[0.14em] text-bone/60">WED 12 AUG</div>
          <div className="mt-1 text-[62px] leading-none font-semibold tracking-[-0.03em] text-bone">
            20:41
          </div>
        </div>

        <div className="mt-9 px-3">
          <div className="rounded-[16px] border border-ember/20 bg-[#181310]/85 px-3.5 py-3 backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="text-ember">
                <Mark size={13} />
              </span>
              <span className="font-narrow text-[10px] font-semibold tracking-[0.18em] text-dim uppercase">
                Firetower
              </span>
              <span className="ml-auto font-mono text-[10px] text-mute">now</span>
            </div>
            <div className="mt-1.5 text-[13.5px] font-semibold text-bone">
              frontend / navbar rebuild
            </div>
            <div className="mt-0.5 text-[13px] text-dim">Codex needs input.</div>
          </div>

          <div className="mt-2 rounded-[16px] border border-line bg-[#141210]/70 px-3.5 py-2.5 backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="text-mute">
                <Mark size={12} />
              </span>
              <span className="font-narrow text-[10px] font-semibold tracking-[0.18em] text-mute uppercase">
                Firetower
              </span>
              <span className="ml-auto font-mono text-[10px] text-mute">18m</span>
            </div>
            <div className="mt-1 text-[12.5px] text-mute">
              payments / idempotency keys — finished
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Inbox() {
  const busy = working().slice(0, 3);
  return (
    <div className="flex h-full flex-col bg-ground">
      <StatusBar />
      <div className="flex items-center gap-2 px-4 pt-2 pb-3">
        <span className="text-bone">
          <Mark size={18} />
        </span>
        <span className="font-narrow text-[12px] font-semibold tracking-[0.22em] text-bone uppercase">
          Firetower
        </span>
        <span className="ml-auto text-[16px] text-mute">⌄</span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="eyebrow">Needs you</span>
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[10px] text-mute">2</span>
        </div>

        <div className="relative overflow-hidden rounded-[8px] border border-ember/25 bg-ember/[0.04] px-3 py-3">
          <span className="absolute inset-y-0 left-0 w-[2px] bg-ember" />
          <div className="flex items-center gap-2">
            <Signal status="NeedsYou" size={6} />
            <span className="font-mono text-[10.5px] text-mute">acme/frontend</span>
            <span className="ml-auto font-mono text-[10.5px] text-mute">7m</span>
          </div>
          <div className="mt-1 text-[13.5px] font-semibold text-bone">{nav.name}</div>
          <p className="mt-1.5 line-clamp-3 text-[12.5px] leading-[1.5] text-text">
            {nav.question}
          </p>
          <button className="mt-2.5 w-full rounded-[6px] bg-ember py-1.5 text-[12.5px] font-semibold text-[#1a0c04]">
            Reply
          </button>
        </div>

        <div className="relative mt-2 overflow-hidden rounded-[8px] border border-line bg-panel px-3 py-3">
          <span className="absolute inset-y-0 left-0 w-[2px] bg-sage" />
          <div className="flex items-center gap-2">
            <Signal status="HandedBack" size={6} />
            <span className="font-mono text-[10.5px] text-mute">acme/payments</span>
            <span className="ml-auto font-mono text-[10.5px] text-mute">5m</span>
          </div>
          <div className="mt-1 text-[13.5px] font-semibold text-bone">{idem.name}</div>
          <div className="mt-1 font-mono text-[11.5px]">
            <span className="text-sage">+{idem.files.reduce((a, f) => a + f.add, 0)}</span>{" "}
            <span className="text-brick">−{idem.files.reduce((a, f) => a + f.del, 0)}</span>{" "}
            <span className="text-mute">· {idem.files.length} files</span>
          </div>
          <button className="mt-2.5 w-full rounded-[6px] border border-line bg-raise py-1.5 text-[12.5px] font-medium text-text">
            Review changes
          </button>
        </div>

        <div className="mt-5 mb-2 flex items-center gap-2">
          <span className="eyebrow">Working</span>
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[10px] text-mute">{busy.length}</span>
        </div>
        <div className="rounded-[8px] border border-line bg-panel">
          {busy.map((t, i) => (
            <div
              key={t.id}
              className={`flex items-center gap-2 px-3 py-2.5 ${i > 0 ? "border-t border-line-soft" : ""}`}
            >
              <Signal status={t.status} size={6} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">{t.name}</span>
              <span className="font-mono text-[10.5px] text-mute">{elapsed(t.minutes)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Reply() {
  return (
    <div className="flex h-full flex-col bg-ground">
      <StatusBar />
      <div className="flex items-center gap-2 border-b border-line px-3 pt-2 pb-2.5">
        <span className="text-mute">←</span>
        <span className="text-[13px] font-semibold text-bone">navbar rebuild</span>
        <span className="ml-auto">
          <Signal status="NeedsYou" size={6} />
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-4 pt-4">
        <div className="font-narrow text-[10px] font-semibold tracking-[0.16em] text-slate uppercase">
          Codex · 7 minutes ago
        </div>
        <p className="mt-3 text-[15px] leading-[1.55] text-bone">{nav.question}</p>

        <div className="mt-5">
          <div className="eyebrow mb-1.5">Changed so far</div>
          <div className="rounded-[6px] border border-line bg-panel px-3 py-2.5 font-mono text-[10.5px] leading-[1.9]">
            {nav.files.map((f) => (
              <div key={f.path} className="flex items-baseline gap-2">
                <span className={f.mode === "A" ? "text-sage" : "text-mute"}>{f.mode}</span>
                <span className="min-w-0 flex-1 truncate text-dim">
                  {f.path.replace("src/", "")}
                </span>
                <span className="text-sage">+{f.add}</span>
                {f.del > 0 && <span className="text-brick">−{f.del}</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-auto pb-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 rounded-[10px] border border-line bg-panel px-3 py-2.5 text-[14px] text-bone">
              Reuse Nav.tsx for both.
            </div>
            <button className="mb-[2px] h-9 w-9 shrink-0 rounded-full bg-ember text-[15px] font-semibold text-[#1a0c04]">
              ↑
            </button>
          </div>
          <button className="mt-3 flex w-full items-center justify-center gap-2 rounded-[6px] border border-line py-2 text-[12.5px] text-dim">
            <span className="font-mono text-[11px]">⌨</span> Open the full terminal
          </button>
        </div>
      </div>
    </div>
  );
}

function PhoneTerminal() {
  return (
    <div className="flex h-full flex-col bg-[#0a0908]">
      <StatusBar />
      <div className="flex items-center gap-2 border-b border-line px-3 pt-2 pb-2.5">
        <span className="text-mute">←</span>
        <span className="font-mono text-[12px] text-bone">stripe retries</span>
        <span className="ml-auto font-mono text-[10.5px] text-mute">fire-02</span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-3 py-3 font-mono text-[10.5px] leading-[1.75]">
        {stripe.transcript.slice(1, 8).map((l, i) => (
          <div key={i} className="mb-1.5">
            {l.kind === "tool" ? (
              <>
                <div className="text-dim">
                  <Bullet /> <span className="text-bone">{l.name}</span>
                  <span className="text-mute">(</span>
                  <span className="text-slate">{l.arg}</span>
                  <span className="text-mute">)</span>
                </div>
                {l.result && <div className="pl-3 text-mute">⎿ {l.result}</div>}
              </>
            ) : l.kind === "say" ? (
              <div className="text-text">
                <Bullet /> {l.text}
              </div>
            ) : null}
          </div>
        ))}
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-ember">›</span>
          <span className="caret inline-block h-[12px] w-[6px] bg-bone" />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-line bg-panel px-2 py-2">
        {["⌃C", "esc", "⇥", "/", "↑", "↓"].map((k) => (
          <span
            key={k}
            className="flex-1 rounded-[5px] border border-line bg-raise py-1.5 text-center font-mono text-[11px] text-dim"
          >
            {k}
          </span>
        ))}
      </div>
    </div>
  );
}
