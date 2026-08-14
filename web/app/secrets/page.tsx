"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSecrets,
  useRevealSecret,
  useReplaceSecret,
  useRemoveSecret,
  getListSecretsQueryKey,
} from "@/src/api/generated/secrets/secrets";
import type { AccessEntry, HeldSecret } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/**
 * What Firetower holds on your behalf, and every time it was touched.
 *
 * A credential can be shown, replaced, or removed here. Revealing one is a
 * deliberate act with a cost — it puts a live token on a screen and into a
 * clipboard — so it is logged under its own word, `Reveal`, separately from a
 * session quietly using one. The log is what is left to notice it.
 */
export default function Secrets() {
  const [problem, setProblem] = useState<string | null>(null);

  const { data, isLoading, isError } = useListSecrets({
    query: { refetchInterval: 10_000 },
  });

  const held = data?.held ?? [];
  const access = data?.access ?? [];

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <div className="eyebrow">Secrets</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          {isLoading
            ? "Looking…"
            : held.length === 0
              ? "Nothing stored yet."
              : `${held.length} ${held.length === 1 ? "credential" : "credentials"}, encrypted.`}
        </h1>
        <p className="mt-1.5 max-w-[58ch] text-[14px] text-dim">
          Each one is sealed with a key of its own, and those keys are sealed with a root
          key kept outside the database. Reading one — whether a session needs it or you
          ask to see it — leaves a line below.
        </p>
      </header>

      {isError && (
        <p className="panel mb-4 px-4 py-3 text-[13px] text-brick">
          Couldn&apos;t reach the control plane. Is Firetower running?
        </p>
      )}

      {problem && (
        <p className="mb-4 rounded-[6px] border border-ember/30 bg-ember/[0.05] px-3.5 py-2.5 text-[12.5px] text-bone">
          {problem}
        </p>
      )}

      {data && !data.intact && (
        <div className="mb-4 rounded-[6px] border border-brick/40 bg-brick/[0.06] px-3.5 py-3">
          <p className="text-[13px] font-medium text-bone">This log doesn&apos;t verify.</p>
          <p className="mt-1 text-[12.5px] leading-[1.55] text-dim">
            Entry {data.brokenAt} doesn&apos;t follow from the one before it. Either a row
            was edited or removed directly in the database, or the root key isn&apos;t the
            one these entries were written with — and if it isn&apos;t, nothing held here
            will open either.
          </p>
        </div>
      )}

      <section className="mb-7">
        <h2 className="eyebrow mb-2.5">Held</h2>
        <div className="flex flex-col gap-2.5">
          {held.map((s) => (
            <HeldRow
              key={`${s.scope}/${s.name}`}
              secret={s}
              onProblem={setProblem}
            />
          ))}
          {!isLoading && held.length === 0 && !isError && (
            <p className="panel px-4 py-6 text-center text-[13px] text-mute">
              Authorize a git host or configure an agent, and it lands here.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="eyebrow mb-2.5">Every time one was touched</h2>
        <div className="panel divide-y divide-line">
          {access.map((a) => (
            <AccessRow key={a.id} entry={a} />
          ))}
          {!isLoading && access.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-mute">
              Nothing has been read yet.
            </p>
          )}
        </div>
        {data && (
          <p className="mt-3 text-[12px] leading-[1.6] text-mute">
            Each line carries a fingerprint of the line before it, keyed with the root
            key, so a row edited or deleted in the database stops the chain. The root key
            is in {data.rootKey} — back it up separately; the database alone can&apos;t
            open any of this.
          </p>
        )}
      </section>
    </div>
  );
}

/** What a scope means to someone who didn't write it. */
function what(scope: string) {
  switch (scope) {
    case "git":
      return "git host";
    case "agent":
      return "agent";
    default:
      return scope;
  }
}

/** What removing one costs, said before it happens rather than after. */
function consequence(secret: HeldSecret) {
  switch (secret.scope) {
    case "git":
      return `Remove the ${secret.name} token? Cloning and pushing stop working until you authorize it again.`;
    case "agent":
      return `Remove the ${secret.name} credential? Sessions with that agent won't start until you give it another.`;
    default:
      return `Remove ${secret.scope}/${secret.name}?`;
  }
}

function HeldRow({
  secret,
  onProblem,
}: {
  secret: HeldSecret;
  onProblem: (message: string | null) => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const queryClient = useQueryClient();
  const reveal = useRevealSecret();
  const replace = useReplaceSecret();
  const remove = useRemoveSecret();

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey() });
  const failed = (e: unknown) =>
    onProblem(e instanceof ApiError ? e.message : "That didn't work.");

  const { scope, name } = secret;

  const show = () => {
    onProblem(null);
    reveal.mutate(
      { scope, name },
      {
        onSuccess: (r) => {
          setShown(r.value);
          // The list is stale the moment this succeeds: it just wrote a line.
          refresh();
        },
        onError: failed,
      },
    );
  };

  const save = () => {
    onProblem(null);
    replace.mutate(
      { scope, name, data: { value: draft } },
      {
        onSuccess: () => {
          setReplacing(false);
          setDraft("");
          setShown(null);
          refresh();
        },
        onError: failed,
      },
    );
  };

  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sage" />
        <span className="font-mono text-[13.5px] text-bone">{name}</span>
        <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-slate">
          {what(scope)}
        </span>

        <div className="ml-auto flex items-center gap-3.5">
          {shown === null ? (
            <button
              onClick={show}
              disabled={reveal.isPending}
              className="text-[11.5px] text-mute transition-colors hover:text-ember"
            >
              {reveal.isPending ? "Reading…" : "Reveal"}
            </button>
          ) : (
            <button
              onClick={() => {
                setShown(null);
                setCopied(false);
              }}
              className="text-[11.5px] text-mute transition-colors hover:text-ember"
            >
              Hide
            </button>
          )}
          <button
            onClick={() => {
              onProblem(null);
              setReplacing(!replacing);
              setDraft("");
            }}
            className="text-[11.5px] text-mute transition-colors hover:text-ember"
          >
            {replacing ? "Cancel" : "Replace"}
          </button>
          <button
            onClick={() => {
              onProblem(null);
              if (!confirm(consequence(secret))) return;
              remove.mutate({ scope, name }, { onSuccess: refresh, onError: failed });
            }}
            className="text-[11.5px] text-mute transition-colors hover:text-ember"
          >
            Remove
          </button>
        </div>
      </div>

      {shown !== null && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-start gap-3">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-[1.6] text-bone">
              {shown}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(shown);
                setCopied(true);
              }}
              className="shrink-0 text-[11.5px] text-mute transition-colors hover:text-ember"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 text-[11.5px] text-mute">
            This is now in the log below, with the time you did it.
          </p>
        </div>
      )}

      {replacing && (
        <div className="mt-3 border-t border-line pt-3">
          <label className="eyebrow">The new value</label>
          <input
            autoFocus
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && draft.trim() && save()}
            spellCheck={false}
            className="mt-2 w-full rounded-[6px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone outline-none placeholder:text-mute focus:border-ember/40"
          />
          <div className="mt-2.5 flex items-center gap-3">
            <button
              onClick={save}
              disabled={!draft.trim() || replace.isPending}
              className="rounded-[6px] border border-ember/40 px-3 py-1.5 text-[12px] text-ember transition-colors hover:bg-ember/[0.06] disabled:border-line disabled:text-mute disabled:hover:bg-transparent"
            >
              {replace.isPending ? "Saving…" : "Save it"}
            </button>
            <span className="text-[11.5px] text-mute">
              What&apos;s there now is overwritten and can&apos;t be recovered.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* A session using a credential is routine and stays quiet. A person putting one
   on screen, and a read that didn't verify, are the lines worth finding. */
const TONE: Record<string, string> = {
  Write: "text-sage",
  Read: "text-slate",
  Reveal: "text-ember",
  Delete: "text-mute",
  Failed: "text-brick",
};

function AccessRow({ entry }: { entry: AccessEntry }) {
  const when = new Date(entry.at);

  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5">
      <span className={`w-[52px] shrink-0 font-mono text-[11px] ${TONE[entry.action] ?? "text-mute"}`}>
        {entry.action.toLowerCase()}
      </span>
      <span className="shrink-0 font-mono text-[12px] text-bone">{entry.name}</span>
      <span className="truncate text-[12.5px] text-dim">{entry.reason}</span>
      <span
        className="ml-auto shrink-0 font-mono text-[11px] text-mute"
        title={when.toLocaleString()}
      >
        {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>
  );
}
