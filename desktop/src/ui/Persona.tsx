/**
 * What a session was told it is, where the person typing at it can read it.
 *
 * A profile's system prompt is composed in the control plane and pasted onto
 * the agent's own: nothing in the conversation has ever said what it contains,
 * or that there is one at all. That is fine until an agent behaves like
 * something you did not ask for — or until a run comes back from a restart as
 * a plain agent, which is a thing that used to happen silently.
 *
 * So: the profile's name beside the subscription, in the line under the box,
 * and the text itself a click away. What is shown is the persona *as it was
 * sent*, not the profile as it stands now — see the `persona` endpoint, which
 * is where the difference is explained.
 */
import { useEffect, useState } from "react";
import { UserRound, X } from "lucide-react";
import { useSessionPersona } from "~/api/generated/sessions/sessions";
import { size } from "~/ui/attach";

/** The chip in the composer's hint row. Nothing at all for a plain agent. */
export function PersonaLine({ sessionId, profileId }: { sessionId: string; profileId?: string | null }) {
  const [reading, setReading] = useState(false);
  /* Only asked for when the session has a profile, so the ordinary run — which
     is most of them — costs no request. A persona does not change while a
     session runs: it is composed at launch and stored, and a relaunch reloads
     the page anyway. */
  const persona = useSessionPersona(sessionId, {
    query: { enabled: !!profileId, staleTime: Infinity },
  });
  const text = persona.data?.text ?? "";
  /* The profile may have been deleted since this session started, which takes
     the name and leaves the text. That is exactly the session somebody is
     puzzling over, so it keeps a chip — with the one word there is left. */
  const name = persona.data?.profile ?? "Profile";
  if (!profileId || !text) return null;

  return (
    <>
      <button
        onClick={() => setReading(true)}
        title="The profile this session is running as, and what it was told"
        className="ml-auto flex min-w-0 items-center gap-1.5 text-mute hover:text-bone"
      >
        <UserRound className="h-3 w-3 shrink-0" strokeWidth={1.75} />
        <span className="truncate">{name}</span>
      </button>
      {reading && <PersonaSheet name={name} text={text} onClose={() => setReading(false)} />}
    </>
  );
}

function PersonaSheet({ name, text, onClose }: { name: string; text: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 pt-[10vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="flex max-h-[70vh] w-[40rem] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">{name}</h2>
          <span className="text-meta text-mute">{size(new Blob([text]).size)}</span>
          <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <pre className="font-mono text-meta whitespace-pre-wrap text-bone">{text}</pre>
        </div>

        <div className="border-t border-line bg-ground/40 px-5 py-3">
          <p className="text-meta text-mute">
            What this session was started with, in front of everything it has been asked. Editing the profile in
            Configuration changes what the next session gets, not this one.
          </p>
        </div>
      </div>
    </div>
  );
}
