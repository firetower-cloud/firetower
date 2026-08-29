"use client";

import { useCallback, useState } from "react";
import { useSendTurn } from "@/src/api/generated/sessions/sessions";
import { Markdown } from "@/components/Markdown";
import { Annotatable, Drafting, Notes, type Draft } from "@/components/Annotate";
import { useNotes, asMessage } from "@/src/api/notes";
import { useFileText, isMarkdown, MOST } from "@/src/api/text";
import { ApiError } from "@/src/api/http";
import { useOpen, useTabs } from "@/src/workspace/tabs";

/**
 * A file out of the workspace, as something to read and argue with.
 *
 * This is where a plan gets reviewed. Agents write plans as markdown — to a
 * file, or into a message that is easier to keep as one — and reviewing them in
 * a transcript has two problems: the plan scrolls away, and it is gone the
 * moment the conversation moves on. A file has neither. It stays open beside
 * the conversation while the agent works, it can be reopened tomorrow, and the
 * notes written against it go back as an ordinary message.
 *
 * The annotation machinery is the one the conversation already uses. Nothing
 * here is new except what it is pointed at.
 */
export function FileTab({ sessionId, path }: { sessionId: string; path: string }) {
  const { data, isLoading, error, refetch } = useFileText(sessionId, path);
  const { set } = useTabs();
  const open = useOpen();

  const { notes, add, drop } = useNotes(sessionId);
  /** Only what was written against this file — the conversation keeps its own. */
  const mine = notes.filter((n) => n.item === path);
  const [draft, setDraft] = useState<Draft | null>(null);
  const send = useSendTurn();

  const begin = useCallback(
    (item: string, quote: string, first: string) => setDraft({ item, quote, note: first }),
    [],
  );

  const sendNotes = () => {
    if (send.isPending || mine.length === 0) return;
    // Named, because the agent is being asked about a specific document and a
    // bare list of quotes does not say which one.
    const text = `On \`${path}\`:\n\n${asMessage(mine)}`;
    for (const n of mine) drop(n.id);
    send.mutate({ id: sessionId, data: { text, images: [] } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-slate" title={path}>
          {path}
        </span>
        {!set?.split && (
          <button
            onClick={() => open.file(path, true)}
            title="Open beside"
            className="shrink-0 text-meta text-mute transition-colors hover:text-bone"
          >
            ⊞
          </button>
        )}
        <button
          onClick={() => refetch()}
          title="Read it again"
          className="shrink-0 text-meta text-mute transition-colors hover:text-bone"
        >
          ↻
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <Note>Reading…</Note>}

        {error && (
          <Note>{error instanceof ApiError ? error.message : "Couldn't read that file."}</Note>
        )}

        {data?.kind === "binary" && (
          <Note>
            That isn&apos;t text — {kb(data.bytes)} of something else. The Files panel will
            download it.
          </Note>
        )}

        {data?.kind === "huge" && (
          <Note>
            {kb(data.bytes)} is more than a tab is for — the limit is {kb(MOST)}. Download it, or
            look at it in the shell.
          </Note>
        )}

        {data?.kind === "text" &&
          (isMarkdown(path) ? (
            <div className="mx-auto max-w-[80ch] px-6 py-6">
              {/* One annotatable region for the document, keyed by its path so
                  notes written here can be told apart from notes written
                  against the conversation. */}
              <Annotatable item={path} drafting={draft !== null} onBegin={begin}>
                <Markdown>{data.text}</Markdown>
              </Annotatable>
            </div>
          ) : (
            <Code text={data.text} />
          ))}
      </div>

      {(draft || mine.length > 0) && (
        <div className="shrink-0 border-t border-line px-3 pt-2 pb-2">
          {draft && (
            <Drafting
              draft={draft}
              onChange={(note) => setDraft({ ...draft, note })}
              onKeep={() => {
                if (draft.note.trim()) add(draft.item, draft.quote, draft.note.trim());
                setDraft(null);
              }}
              onCancel={() => setDraft(null)}
            />
          )}

          {mine.length > 0 && !draft && (
            <>
              <div className="mb-1.5 flex items-center gap-3">
                <span className="eyebrow">
                  {mine.length} {mine.length === 1 ? "note" : "notes"}
                </span>
                <span className="h-px flex-1 bg-line" />
                <button
                  onClick={sendNotes}
                  disabled={send.isPending}
                  className="rounded-md bg-bone px-2.5 py-1 text-meta font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
                >
                  {send.isPending ? "Sending…" : "Send to the agent"}
                </button>
              </div>
              <div className="max-h-[26vh] overflow-y-auto">
                <Notes notes={mine} onDrop={drop} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Anything that is not markdown, with the line numbers a person needs to talk
 * about it. Not an editor: the agent writes the files, and a half-editor that
 * cannot save is worse than a good reader.
 */
function Code({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="px-3 py-2 font-mono text-meta leading-[1.6] text-dim">
      {lines.map((line, i) => (
        <div key={i} className="flex gap-3">
          <span className="w-10 shrink-0 select-none text-right text-mute/60">{i + 1}</span>
          <span className="whitespace-pre-wrap">{line || " "}</span>
        </div>
      ))}
    </pre>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <p className="max-w-[44ch] text-center text-ui text-mute">{children}</p>
    </div>
  );
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
