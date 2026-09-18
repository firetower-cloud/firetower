/**
 * A picture out of the workspace, as something to look at and argue with.
 *
 * Agents draw and capture: a screenshot of the app they just changed, a graph
 * they rendered, a diagram they exported. The file viewer's answer to all of
 * those used to be "a binary file, nothing to draw", which is true of a
 * lockfile and useless for a screenshot.
 *
 * The bytes come off the worker through the same `useFileText` a file tab
 * uses; it hands pictures back as a blob URL, because the desktop shell's CSP
 * allows `blob:` for images and not `http:`, and because the request carries a
 * bearer token that an `<img>` could not send.
 *
 * Clicking the picture starts a note pinned to the point you clicked, sent
 * back as an ordinary message — the same gesture the file tab gives a line of
 * code, because "this button is the wrong colour" wants a place on the image
 * the way "this branch is wrong" wants a line number.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bot, Check, Copy, Maximize2, Minimize2, Send, X } from "lucide-react";
import { useFileText } from "~/api/text";
import { sendTurn } from "~/api/generated/sessions/sessions";
import type { Session } from "~/api/generated/model";
import { Annotate, type Anchor } from "~/ui/Annotate";
import { AddAgent } from "~/ui/AddAgent";
import { why } from "~/data";

/** A note against a point on the picture, in per-cent of its natural size. */
type Spot = { id: number; x: number; y: number; text: string };

export function ImageTab({ session, path }: { session: Session; path: string }) {
  const sessionId = session.id;
  const remote = useFileText(sessionId, path);
  const image = remote.data?.kind === "image" ? remote.data : null;

  /* What the file actually is, rather than what it is drawn at. */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [drafting, setDrafting] = useState<(Anchor & { at: { x: number; y: number } }) | null>(null);
  const [reading, setReading] = useState<Spot | null>(null);
  const [handing, setHanding] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  /* A new picture is a new set of marks: the ones from the last file are not
     about this one. */
  useEffect(() => {
    setSpots([]);
    setDrafting(null);
    setNatural(null);
    setFull(false);
  }, [path]);

  /**
   * What gets said to the agent.
   *
   * Positions in per-cent, because that is the only frame of reference the two
   * ends share — the agent has the file, not the window it was drawn in, and
   * "38% across, 71% down" survives a resize where a pixel offset does not.
   */
  const message = () =>
    `On \`${path}\`:\n\n${spots
      .map((s, i) => `${i + 1}. At ${Math.round(s.x)}% across, ${Math.round(s.y)}% down:\n\n${s.text}`)
      .join("\n\n")}`;

  const send = useMutation({
    mutationFn: () => sendTurn(sessionId, { text: message(), images: [] }),
    onSuccess: () => setSpots([]),
  });

  const copy = async () => {
    if (!image) return;
    try {
      /* The bytes, not the path: a picture on the clipboard should paste into
         the thing you are about to paste it into as a picture. */
      const blob = await fetch(image.url).then((r) => r.blob());
      await navigator.clipboard?.write?.([new ClipboardItem({ [blob.type]: blob })]);
    } catch {
      /* Not every shell allows an image on the clipboard. The path is the
         next most useful thing, and always works. */
      navigator.clipboard?.writeText(path);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const takePoint = (e: React.MouseEvent<HTMLImageElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const x = ((e.clientX - box.left) / box.width) * 100;
    const y = ((e.clientY - box.top) / box.height) * 100;
    setDrafting({
      quote: `${Math.round(x)}% across, ${Math.round(y)}% down`,
      line: 0,
      label: "Note on this point",
      x: e.clientX,
      y: e.clientY,
      at: { x, y },
    });
  };

  /* The states a picture can be in that are not "here it is". */
  if (remote.isPending) return <Plain path={path}>Reading it off the worker…</Plain>;
  if (remote.error) return <Plain path={path}>{why(remote.error)}</Plain>;
  if (remote.data?.kind === "huge") return <Plain path={path}>{size(remote.data.bytes)} — too much to put on a screen.</Plain>;
  if (!image) return <Plain path={path}>That isn't a picture after all. Nothing to draw.</Plain>;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-ground">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-slate" title={path}>{path}</span>
        <span className="shrink-0 font-mono text-micro text-mute">
          {natural ? `${natural.w} × ${natural.h}` : "—"}
          <span className="ml-2">{size(image.bytes)}</span>
        </span>
        <button
          onClick={() => setFull(!full)}
          title={full ? "Fit to the window" : "Show it at its own size"}
          className="control h-6 text-micro text-mute hover:bg-raise hover:text-bone"
        >
          {full ? <Minimize2 className="h-3 w-3" strokeWidth={1.75} /> : <Maximize2 className="h-3 w-3" strokeWidth={1.75} />}
          {full ? "fit" : "100%"}
        </button>
        <button onClick={copy} title="Copy the picture" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone">
          {copied ? <Check className="h-3.5 w-3.5 text-sage" strokeWidth={2} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}
        </button>
      </header>

      <div className={`scroll-slim min-h-0 flex-1 ${full ? "overflow-auto" : "grid place-items-center overflow-hidden"} p-4`}>
        {/* The backdrop is checked rather than flat: a transparent PNG on a
            dark panel is indistinguishable from a dark PNG, and which one you
            are looking at is usually the question. */}
        <div ref={frame} className={`relative ${full ? "inline-block" : "max-h-full"} ft-checks rounded-md`}>
          <img
            src={image.url}
            alt={path}
            onClick={takePoint}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className={`block cursor-crosshair rounded-md ${full ? "max-w-none" : "max-h-full max-w-full object-contain"}`}
            style={full && natural ? { width: natural.w, height: natural.h } : undefined}
          />
          {spots.map((s, i) => (
            <button
              key={s.id}
              onClick={(e) => { e.stopPropagation(); setReading(s); }}
              title={s.text}
              style={{ left: `${s.x}%`, top: `${s.y}%` }}
              className="absolute grid h-5 w-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-ground bg-ember text-micro font-medium text-ground shadow-(--shadow-float)"
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>

      {drafting && (
        <Annotate
          at={drafting}
          onCancel={() => setDrafting(null)}
          onKeep={(t) => {
            setSpots((held) => [...held, { id: Date.now(), x: drafting.at.x, y: drafting.at.y, text: t }]);
            setDrafting(null);
          }}
        />
      )}

      {spots.length > 0 && !drafting && (
        <div className="pointer-events-none absolute right-5 bottom-5 z-30 flex justify-end">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line bg-overlay py-1.5 pr-1.5 pl-3.5 shadow-(--shadow-float)">
            <span className="text-ui text-dim">{spots.length} note{spots.length > 1 ? "s" : ""}</span>
            <button onClick={() => setSpots([])} title="Discard them" className="grid h-6 w-6 place-items-center rounded-full text-mute transition-colors hover:bg-raise hover:text-bone"><X className="h-3.5 w-3.5" strokeWidth={2} /></button>
            <button onClick={() => setHanding(true)} title="Start another agent in this workspace, on these notes" className="control rounded-full text-dim hover:bg-raise hover:text-bone disabled:text-mute">
              <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />Another agent…
            </button>
            <button disabled={send.isPending} onClick={() => send.mutate()} className="control rounded-full bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute">
              <Send className="h-3.5 w-3.5" strokeWidth={2} />{send.isPending ? "Sending…" : "Send to the agent"}
            </button>
          </div>
        </div>
      )}
      {handing && <AddAgent session={session} workspaceId={session.workspaceId ?? session.id} prompt={message()} onClose={() => setHanding(false)} onStarted={() => setSpots([])} />}

      {reading && (
        <Annotate
          at={{ quote: `${Math.round(reading.x)}% across, ${Math.round(reading.y)}% down`, line: 0, label: "Note on this point", x: window.innerWidth / 2, y: 160 }}
          onCancel={() => setReading(null)}
          onKeep={(t) => { setSpots((held) => held.map((s) => (s.id === reading.id ? { ...s, text: t } : s))); setReading(null); }}
        />
      )}
    </div>
  );
}

function Plain({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-ground">
      <div className="max-w-[24rem] text-center">
        <p className="font-mono text-ui text-dim">{path}</p>
        <p className="mt-2 text-meta text-mute">{children}</p>
      </div>
    </div>
  );
}

const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
