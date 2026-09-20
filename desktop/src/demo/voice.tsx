/**
 * Every state of the microphone, on one page, in the real composer.
 *
 * Not a mock of the composer — the composer, imported, with a `QueryClient`
 * that answers from fixtures instead of a server. A redrawn copy would drift
 * within a week and the thing being reviewed would stop being the thing that
 * ships.
 *
 * Dictation is forced through `ForceVoice`, because half of these states are
 * unreachable by talking at the app on purpose: a revoked key, a permission
 * macOS has already refused, the quarter-second while the last words land.
 * They are also the states most worth looking at, since nobody sees them until
 * something has gone wrong.
 *
 * Dev only. Vite serves it at `/demo.html`; it is not a build entry, so it
 * cannot reach a production bundle.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Composer } from "~/ui/Composer";
import { getSessionControlsQueryKey } from "~/api/generated/conversation/conversation";
import { ForceVoice } from "~/ui/voice/useVoice";
import type { Blocked, Dictating, Voice } from "~/ui/voice/state";
import type { Conversation } from "~/api/conversation";
import type { Session } from "~/api/generated/model";
import { leaveDraft } from "~/workspace/draft";
import "~/styles.css";

/* The pickers, as the agent would report them. Seeded into the cache rather
   than served by a default `queryFn`, because the generated hooks carry their
   own and never fall through to one. */
const CONTROLS = [
    {
      kind: "model",
      fallback: "Model",
      current: "opus-5",
      choices: [
        { value: "opus-5", label: "Opus 5" },
        { value: "sonnet-5", label: "Sonnet 5" },
      ],
    },
    {
      kind: "mode",
      fallback: "Mode",
      current: "plan",
      choices: [
        { value: "plan", label: "Plan" },
        { value: "build", label: "Build" },
      ],
    },
];

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => [] } },
});

/* Each state gets its own session id, so that the text each composer starts
   with can be handed to it through the draft handoff the app already has —
   rather than adding a prop to `Composer` that only the demo would ever set. */
const sessionFor = (title: string) => ({ id: `s_${title.replace(/\W+/g, "_")}`, agent: "claude-code" }) as unknown as Session;
const conversation = {
  model: "opus-5",
  mode: "plan",
  commands: [],
  working: false,
  usage: { contextUsed: 47_000, contextWindow: 200_000 },
} as unknown as Conversation;

const nothing = () => {};
const base: Dictating = {
  state: { at: "idle" },
  blocked: null,
  start: nothing,
  stop: nothing,
  typed: nothing,
  dismiss: nothing,
  configure: async () => {},
  possible: true,
};

/* A dialog is `fixed inset-0`, so four of them on one page are four sheets
   stacked on the viewport rather than four states to compare. `?only=` draws
   one, which is also how each is captured on its own. */
const only = new URLSearchParams(location.search).get("only");

/** One state, captioned, in the real composer. */
function State({
  title,
  note,
  text = "",
  voice,
}: {
  title: string;
  note: string;
  text?: string;
  voice?: Partial<Dictating>;
}) {
  if (only && only !== title) return null;
  const session = sessionFor(title);
  if (text) leaveDraft(session.id, text);
  client.setQueryData(getSessionControlsQueryKey(session.id), CONTROLS);
  return (
    <section data-state={title} className="mb-10">
      <h2 className="px-8 text-ui text-bone">{title}</h2>
      <p className="mt-1 mb-2 px-8 text-meta text-mute">{note}</p>
      <ForceVoice value={{ ...base, ...voice }}>
        <Composer
          key={title}
          session={session}
          conversation={conversation}
          onEcho={nothing}
          onRemember={nothing}
          onStopping={nothing}
          disabled={false}
          asking={false}
        />
      </ForceVoice>
    </section>
  );
}

const listening = (over: Partial<Extract<Voice, { at: "listening" }>>): Voice => ({
  at: "listening",
  level: 0.7,
  seconds: 7,
  hearing: true,
  ...over,
});

const blocked = (b: Blocked): Partial<Dictating> => ({ blocked: b });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <div className="min-h-screen bg-ground pt-8 pb-16 text-text">
        {!only && <h1 className="mb-8 px-8 text-display text-bone">Dictation</h1>}

        <State title="Idle" note="The microphone sits beside the paperclip — same height, same weight. It is another way to put something in the message, not a second send button." />

        <State
          title="Connecting"
          note="Between the permission being granted and the socket being open. Named, because a spinner that does not say what it is waiting for is indistinguishable from a hang."
          voice={{ state: { at: "connecting" } }}
        />

        <State
          title="Listening — speaking"
          note="The control grows into a pill. The bars are the audio actually being sent, so the meter and the transcript can never disagree. Settled words are at full weight."
          text="Refactor the vault module so the scope is a typed enum"
          voice={{ state: listening({}) }}
        />

        <State
          title="Listening — silent"
          note="The same pill, hearing nothing. The bars stay the same width and drop to dim, so silence reads as silence rather than as a stall — and the clock keeps moving, because the socket is billed by the second."
          text="Refactor the vault module so the scope is a typed enum"
          voice={{ state: listening({ level: 0.06, hearing: false, seconds: 11 }) }}
        />

        <State
          title="Settling"
          note="Stop has been pressed and the model still owes us the end of the sentence. A quarter of a second, and the reason the last words are not eaten."
          text="Refactor the vault module so the scope is a typed enum rather than a free string"
          voice={{ state: { at: "settling" } }}
        />

        <State
          title="Server too old"
          note="What a self-updating app pointed at an un-updated control plane looks like. Said plainly, because it is nobody's mistake — and emphatically not reported as OpenAI refusing a key, which is what it used to say."
          voice={blocked({ why: "unsupported" })}
        />

        <State
          title="Not set up — administrator"
          note="The button is always there. Pressing it when this Firetower has no key opens the way to give it one, and then starts listening — you asked for the microphone, not for a dialog."
          voice={blocked({ why: "unconfigured", mayConfigure: true })}
        />

        <State
          title="Not set up — member"
          note="No field, because there is nothing this person can do with one. A button that answers 'you may not' is worse than no button."
          voice={blocked({ why: "unconfigured", mayConfigure: false })}
        />

        <State
          title="Microphone refused"
          note="macOS is blocking it and will not ask again. A numbered procedure, because it is carried out in another application from memory."
          voice={blocked({ why: "denied" })}
        />

        <State
          title="Microphone refused — Windows"
          note="The same state on the other platform. Different words, a different deep link, and a second step macOS does not have: the per-app list sits under a master toggle for desktop applications, and with that off the app never appears in the list at all."
          voice={blocked({ why: "denied" })}
        />

        <State
          title="Key rejected"
          note="Not the person's fault and nothing to grant, so a different dialog — and the fix is only offered to somebody who can carry it out."
          voice={blocked({ why: "rejected", detail: "401 Incorrect API key provided", mayConfigure: true })}
        />
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
