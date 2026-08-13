import type { Line, Session } from "@/lib/data";

/* ⏺ renders as an emoji on macOS — draw the bullet instead. */
export const Bullet = () => (
  <span className="mr-[3px] inline-block h-[6px] w-[6px] rounded-full bg-ember-soft align-[0.15em]" />
);

/* A stand-in for the real PTY. The point of the layout is that the terminal
   is the page, not a tab you have to go find. */

export function Terminal({ session, live }: { session: Session; live: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0a0908]">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 font-mono text-[12.5px] leading-[1.75]">
        {session.transcript.map((l, i) => (
          <Row key={i} line={l} />
        ))}

        {live && (
          <div className="mt-3 flex items-center gap-2 text-bone">
            <span className="text-ember">›</span>
            <span className="caret inline-block h-[15px] w-[7px] bg-bone align-middle" />
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-line bg-[#12100e] px-3 py-1 font-mono text-[10.5px] text-mute">
        <span className="rounded-[3px] bg-sage/15 px-1.5 py-0.5 text-sage">firetower</span>
        <span className="text-dim">0:{session.agent === "Codex" ? "codex" : "claude"}*</span>
        <span>1:shell</span>
        <span>2:dev</span>
        <span className="ml-auto">
          {session.host} · {session.branch}
        </span>
      </div>
    </div>
  );
}

function Row({ line }: { line: Line }) {
  if (line.kind === "you") {
    return (
      <div className="my-3 rounded-[5px] border border-line bg-raise px-3 py-2">
        <div className="eyebrow mb-1">You</div>
        <div className="text-[12.5px] text-text">{line.text}</div>
      </div>
    );
  }

  if (line.kind === "note") {
    return <div className="my-2 pl-4 text-mute">⎿ {line.text}</div>;
  }

  if (line.kind === "tool") {
    return (
      <div className="my-1.5">
        <div className="text-dim">
          <Bullet /> <span className="text-bone">{line.name}</span>
          <span className="text-mute">(</span>
          <span className="text-slate">{line.arg}</span>
          <span className="text-mute">)</span>
        </div>
        {line.result && <div className="pl-4 text-mute">⎿ {line.result}</div>}
      </div>
    );
  }

  return (
    <div className="my-2.5 text-text">
      <Bullet /> {line.text}
    </div>
  );
}
