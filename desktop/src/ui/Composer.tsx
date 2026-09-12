/**
 * Saying something to the agent.
 *
 * A message is not keystrokes, which is the whole reason this exists rather
 * than a prompt in a terminal: a picture of the bug, a log file dropped in, a
 * model chosen for this turn, and a read on how much room is left in the
 * context window before the answer gets worse.
 *
 * Images go in the message. Other files are put into the workspace and only
 * *named* in the message — the agent has its own tools for reading a file, so
 * sending the bytes twice is waste.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, FileUp, ImageIcon, Paperclip, Square, X } from "lucide-react";

type Attached = { name: string; kind: "image" | "file"; size: string; url?: string };

const MODELS = [
  ["opus-5", "Opus 5", "Slowest, and the one that gets it right"],
  ["sonnet-5", "Sonnet 5", "The everyday choice"],
  ["haiku-4.5", "Haiku 4.5", "Fast, for small edits"],
] as const;

const MODES = [
  ["auto", "Auto", "Stops only for things it can't take back"],
  ["ask", "Ask first", "Stops before every write"],
  ["full", "Full access", "Never stops"],
] as const;

export function Composer({ asking }: { asking: boolean }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attached[]>([]);
  const [over, setOver] = useState(false);
  const [model, setModel] = useState("opus-5");
  const [mode, setMode] = useState("auto");
  const [sent, setSent] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  /* Grow to fit, to a ceiling. A composer that scrolls at three lines makes
     people write somewhere else and paste it in. */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const take = (list: FileList | null) => {
    if (!list) return;
    setFiles((held) => [
      ...held,
      ...[...list].map((f) => ({
        name: f.name,
        kind: f.type.startsWith("image/") ? ("image" as const) : ("file" as const),
        size: f.size > 1e6 ? `${(f.size / 1e6).toFixed(1)} MB` : `${Math.ceil(f.size / 1024)} KB`,
        url: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
      })),
    ]);
  };

  const send = () => {
    if (!text.trim() && files.length === 0) return;
    setText("");
    setFiles([]);
    setSent(true);
    setTimeout(() => setSent(false), 1600);
  };

  return (
    <div className="shrink-0 px-8 pb-6">
      <div className="mx-auto w-full max-w-[46rem]">
        {sent && (
          <div className="mb-2 flex items-center gap-2 text-meta text-sage">
            <Check className="h-3.5 w-3.5" strokeWidth={2} />
            Sent.
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            take(e.dataTransfer.files);
          }}
          className={`relative rounded-2xl border bg-panel shadow-(--shadow-float) transition-colors duration-150 ${
            over ? "border-slate" : "border-line focus-within:border-line-soft"
          }`}
        >
          {over && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-ground/80">
              <span className="flex items-center gap-2 text-ui text-slate">
                <FileUp className="h-4 w-4" strokeWidth={1.75} />
                Drop it in the workspace
              </span>
            </div>
          )}

          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {files.map((f, i) => (
                <Chip key={i} file={f} onDrop={() => setFiles((h) => h.filter((_, n) => n !== i))} />
              ))}
            </div>
          )}

          <textarea
            ref={box}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => take(e.clipboardData.files)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={asking ? "Answer above, or say something else" : "Say something to the agent"}
            className="scroll-slim block w-full resize-none bg-transparent px-4 py-3.5 text-read text-text placeholder:text-mute focus:outline-none"
          />

          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <label className="control cursor-pointer text-mute hover:bg-raise hover:text-bone" title="Attach a file or an image">
              <Paperclip className="h-4 w-4" strokeWidth={1.75} />
              <input type="file" multiple className="hidden" onChange={(e) => take(e.target.files)} />
            </label>

            <Menu value={model} onPick={setModel} options={MODELS} />
            <Menu value={mode} onPick={setMode} options={MODES} />

            <Context used={62_400} window={200_000} />

            <button
              onClick={send}
              disabled={!text.trim() && files.length === 0}
              title="Send"
              className="ml-auto grid h-8 w-8 place-items-center rounded-full bg-bone text-ground transition-opacity duration-150 hover:opacity-90 disabled:bg-raise disabled:text-mute"
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 px-1 text-micro text-mute">
          <span className="flex items-center gap-1">
            <span className="keycap">⏎</span> send
          </span>
          <span className="flex items-center gap-1">
            <span className="keycap">⇧⏎</span> new line
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Square className="h-3 w-3" strokeWidth={2} /> stop
          </span>
        </div>
      </div>
    </div>
  );
}

function Chip({ file, onDrop }: { file: Attached; onDrop: () => void }) {
  return (
    <span className="group/chip flex items-center gap-2 rounded-lg border border-line bg-raise py-1 pr-1 pl-2">
      {file.url ? (
        <img src={file.url} alt="" className="h-7 w-7 rounded object-cover" />
      ) : (
        <span className="grid h-7 w-7 place-items-center rounded bg-ground text-mute">
          <ImageIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
      )}
      <span className="max-w-[11rem] truncate text-meta text-text">{file.name}</span>
      <span className="text-micro text-mute">{file.size}</span>
      <button
        onClick={onDrop}
        className="grid h-5 w-5 place-items-center rounded text-mute transition-colors hover:bg-overlay hover:text-bone"
      >
        <X className="h-3 w-3" strokeWidth={2} />
      </button>
    </span>
  );
}

function Menu<T extends string>({
  value,
  onPick,
  options,
}: {
  value: T;
  onPick: (v: T) => void;
  options: readonly (readonly [T, string, string])[];
}) {
  const [open, setOpen] = useState(false);
  const here = options.find((o) => o[0] === value);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="control text-mute hover:bg-raise hover:text-bone"
      >
        {here?.[1]}
        <ChevronDown className="h-3 w-3" strokeWidth={2} />
      </button>

      {open && (
        <>
          <button className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-30 mb-1.5 w-[16rem] overflow-hidden rounded-lg border border-line bg-overlay p-1 shadow-(--shadow-float)">
            {options.map(([v, label, why]) => (
              <button
                key={v}
                onClick={() => {
                  onPick(v);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-raise"
              >
                <Check
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${v === value ? "text-bone" : "text-transparent"}`}
                  strokeWidth={2}
                />
                <span>
                  <span className="block text-ui text-bone">{label}</span>
                  <span className="block text-meta text-mute">{why}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * How much room is left before the answer gets worse.
 *
 * A bar rather than a number, because the question is never "how many tokens"
 * — it is "am I near the edge", and the honest answer to that is a shape.
 */
function Context({ used, window: total }: { used: number; window: number }) {
  const full = used / total;
  const tight = full > 0.75;

  return (
    <span className="control gap-2 text-mute" title={`${Math.round(full * 100)}% of the context window used`}>
      <span className="h-1 w-14 overflow-hidden rounded-full bg-ground">
        <span
          className={`block h-full rounded-full ${tight ? "bg-ember" : "bg-slate"}`}
          style={{ width: `${Math.min(100, full * 100)}%` }}
        />
      </span>
      <span className="text-micro tabular-nums">{Math.round(full * 100)}%</span>
    </span>
  );
}
