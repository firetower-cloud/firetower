"use client";

import { useEffect, useRef, useState } from "react";
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
 * inspects it directly: the injected picker captures element context and the
 * trusted annotation panel owns authentication and feedback delivery.
 */
export function PreviewTab({
  sessionId,
  port,
}: {
  sessionId: string;
  port: number;
}) {
  const {
    data: address,
    isLoading,
    isError,
  } = usePreviewAddress(sessionId, {
    port,
  });
  /** Bumped to reload the frame without touching its address. */
  const [reloads, setReloads] = useState(0);

  const frame = useRef<HTMLIFrameElement>(null);
  const [available, setAvailable] = useState(false);
  const [uiOrigin, setUiOrigin] = useState("");
  useEffect(() => {
    // The UI origin is runtime configuration, including in split-port dev mode.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUiOrigin(window.location.origin);
    const receive = (event: MessageEvent) => {
      if (
        address &&
        event.origin === new URL(address.url).origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.source === "firetower-picker" &&
        event.data?.type === "available"
      )
        setAvailable(true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [address]);
  const launchUrl =
    address && uiOrigin
      ? `${address.url}#__firetower_ui=${encodeURIComponent(uiOrigin)}`
      : address?.url;

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
            disabled={!available}
            title={
              available
                ? "Select elements and send feedback"
                : "Annotation unavailable: try Open, or use plain preview for unsupported pages"
            }
            onClick={() =>
              frame.current?.contentWindow?.postMessage(
                { source: "firetower-preview", type: "annotate" },
                new URL(address.url).origin,
              )
            }
            className="transition-colors hover:text-dim disabled:opacity-50"
          >
            Annotate
          </button>
          <button
            onClick={() => {
              setAvailable(false);
              setReloads((n) => n + 1);
            }}
            className="transition-colors hover:text-dim"
          >
            Reload
          </button>
          <a
            href={`${address.url}?__firetower_plain=1`}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-dim"
            title="Open without annotation instrumentation"
          >
            Plain ↗
          </a>
          <a
            href={launchUrl}
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
        ref={frame}
        src={launchUrl}
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
