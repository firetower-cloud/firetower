"use client";

import { useState } from "react";
import { usePreviewAddress } from "@/src/api/generated/sessions/sessions";

/**
 * The application this session is running, in here.
 *
 * The frame points at a hostname of the session's own —
 * `<session>-3000-<signature>.localhost` — which reaches Firetower like any
 * other request and is recognised by its name. Nothing is published and no port
 * is bound, so this works the same whether Firetower runs as a process on your
 * machine, in a container beside you, or on a server somewhere else.
 *
 * It is a real origin, so there is nothing between the page and the browser: no
 * path prefix, no `<base>` tag, no rewritten `Location` headers, and nothing a
 * client-side router can navigate out of. Which also means it is a *different*
 * origin from Firetower and nothing here can look inside the frame. Nothing
 * needs to — when the port has nothing on it, the frame itself says so.
 */
export function PreviewTab({
  sessionId,
  port,
}: {
  sessionId: string;
  port: number;
}) {
  const { data: address, isLoading, isError } = usePreviewAddress(sessionId, {
    port,
  });
  /** Bumped to reload the frame without touching its address. */
  const [reloads, setReloads] = useState(0);

  if (isLoading) return <Waiting />;

  if (isError || !address) {
    return (
      <Explain title="That session has no address.">
        Firetower could not work out where to reach port {port}. The session may
        have ended.
      </Explain>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5 text-meta text-mute">
        <span className="truncate font-mono text-dim">{address.url}</span>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <button
            onClick={() => setReloads((n) => n + 1)}
            className="transition-colors hover:text-dim"
          >
            Reload
          </button>
          <a
            href={address.url}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-dim"
          >
            Open ↗
          </a>
        </div>
      </div>

      <iframe
        key={reloads}
        src={address.url}
        title={`Port ${port} in this session`}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}

function Waiting() {
  return (
    <div className="flex h-full items-center justify-center text-meta text-mute">
      Finding the address…
    </div>
  );
}

function Explain({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="max-w-[52ch]">
        <h2 className="text-body font-semibold text-bone">{title}</h2>
        <p className="mt-2 text-meta leading-relaxed text-mute">{children}</p>
      </div>
    </div>
  );
}
