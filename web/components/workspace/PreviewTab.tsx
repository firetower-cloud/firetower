"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListForwards,
  useCreateForward,
  getListForwardsQueryKey,
} from "@/src/api/generated/sessions/sessions";

/**
 * The application this session is running, in here.
 *
 * The port is opened on this machine and the iframe points at `localhost`, so
 * there is nothing between the page and the browser: no path prefix, no
 * `<base>` tag, no rewritten `Location` headers, and nothing that a
 * client-side router can navigate out of. Everything works because none of it
 * can tell it is being forwarded.
 *
 * That also means this is a different origin from Firetower, so nothing here
 * can look inside the frame. Nothing needs to.
 */
export function PreviewTab({
  sessionId,
  port,
}: {
  sessionId: string;
  port: number;
}) {
  const cache = useQueryClient();
  const { data: ports, isLoading } = useListForwards(sessionId);
  const open = useCreateForward();
  /** Bumped to reload the frame without touching its address. */
  const [reloads, setReloads] = useState(0);
  const [refused, setRefused] = useState<string | null>(null);

  const forwarded = ports?.forwards.find((f) => f.port === port);

  // A worker that is a child process of this control plane shares this
  // machine's network, so its dev server is already here and there is nothing
  // to forward.
  const direct = ports?.alreadyReachable
    ? `http://localhost:${port}`
    : undefined;
  const url = direct ?? forwarded?.url;

  // Opened on arriving at the tab rather than from a button: the tab *is* the
  // request. Only once, and never when there is nothing to open.
  useEffect(() => {
    if (!ports || forwarded || direct || !ports.availableHere) return;
    if (open.isPending) return;

    open
      .mutateAsync({ id: sessionId, data: { port } })
      .then(() =>
        cache.invalidateQueries({
          queryKey: getListForwardsQueryKey(sessionId),
        }),
      )
      .catch((e: unknown) =>
        setRefused(e instanceof Error ? e.message : "that port could not be opened"),
      );
    // `open` is a new object every render; depending on it would re-run this
    // forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, forwarded, direct, sessionId, port]);

  if (isLoading) return <Waiting />;

  // The failure worth being loudest about, because the link would look right
  // and go to the wrong machine entirely.
  if (ports && !ports.availableHere && !direct) {
    return (
      <Explain title="This Firetower isn’t running on your machine.">
        It can only open a port on the machine it runs on, and that isn’t this
        one — <code className="text-dim">localhost</code> here is yours. Run the
        control plane on your machine to preview, or open a terminal in this
        session and look from there.
      </Explain>
    );
  }

  if (refused) {
    return (
      <Explain title={`Nothing to see on ${port} yet.`}>
        {refused}. Start the application in this session — the preview picks it
        up as soon as something answers.
        <Retry
          onClick={() => {
            setRefused(null);
            cache.invalidateQueries({
              queryKey: getListForwardsQueryKey(sessionId),
            });
          }}
        />
      </Explain>
    );
  }

  if (!url) return <Waiting />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5 text-meta text-mute">
        <span className="font-mono text-dim">{url}</span>

        {/* Only when it differs, and then it matters: an application that
            hardcodes its own address will not find itself. */}
        {forwarded && forwarded.local !== forwarded.port && (
          <span className="text-brick">
            {forwarded.port} was taken here — using {forwarded.local}
          </span>
        )}

        {direct && <span>already on this machine</span>}

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setReloads((n) => n + 1)}
            className="transition-colors hover:text-dim"
          >
            Reload
          </button>
          <a
            href={url}
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
        src={url}
        title={`Port ${port} in this session`}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}

function Waiting() {
  return (
    <div className="flex h-full items-center justify-center text-meta text-mute">
      Opening the port…
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

function Retry({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mt-3 block rounded-sm border border-line px-2 py-1 text-meta text-dim transition-colors hover:bg-raise/60"
    >
      Try again
    </button>
  );
}
