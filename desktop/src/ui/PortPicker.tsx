/**
 * Which port to preview.
 *
 * Nothing on the control plane knows what is listening inside a session, so
 * the conversation is read for addresses the agent or its tools printed —
 * newest first — and a field takes everything it missed. 3000 is filled in
 * because it is what most of them pick.
 */
import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { useConversation } from "@/src/api/conversation";
import { suggestPorts } from "~/preview/ports";

export function PortPicker({ sessionId, open: already, onPick, onClose }: { sessionId: string; open: number[]; onPick: (port: number) => void; onClose: () => void }) {
  const { conversation } = useConversation(sessionId);
  const seen = suggestPorts(conversation.items);
  const [typed, setTyped] = useState(String(seen[0]?.port ?? 3000));
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const go = () => {
    const n = Number(typed);
    if (Number.isInteger(n) && n > 0 && n < 65536) onPick(n);
  };

  return (
    <div ref={box} className="absolute top-full right-0 z-40 mt-1.5 w-[22rem] overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)">
      <div className="px-3.5 pt-3 pb-2 text-meta text-dim">Preview a port</div>
      {seen.length > 0 && (
        <ul className="pb-1">
          {seen.map((s) => (
            <li key={s.port}>
              <button onClick={() => onPick(s.port)} className="flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors hover:bg-raise/70">
                <Globe className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
                <span className="w-12 shrink-0 font-mono text-ui text-bone">{s.port}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-micro text-mute">{already.includes(s.port) ? "already open in a tab" : s.why}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
        <span className="text-meta text-mute">Port</span>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && go()}
          className="w-20 rounded-md border border-line bg-ground px-2 py-1 text-right font-mono text-ui text-bone focus:outline-none"
        />
        <button onClick={go} className="control ml-auto bg-bone font-medium text-ground hover:opacity-90">Open</button>
      </div>
    </div>
  );
}
