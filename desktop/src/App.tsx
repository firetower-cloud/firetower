import { useEffect, useState } from "react";
import { ServerStrip, type Scope } from "~/ui/ServerStrip";
import { Inbox } from "~/ui/Inbox";
import { Session } from "~/ui/Session";
import { StylePage } from "~/ui/StylePage";
import { Titlebar } from "~/ui/Titlebar";
import { Palette } from "~/ui/Palette";
import { useInbox } from "~/backend";
import { runTimeline } from "~/mock/socket";
import { bridge } from "~/bridge";
import { usePathname } from "~/shims/next-navigation";

export function App() {
  const [scope, setScope] = useState<Scope>("all");
  const [selected, setSelected] = useState<string | undefined>();
  const { rows, waiting } = useInbox();
  const path = usePathname();

  const [palette, setPalette] = useState(false);

  useEffect(() => runTimeline(), []);

  /* The one global shortcut. Registered here rather than in the Rust menu so it
     works in the browser build too, which is where the design iterates. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Ember reaches the dock. This is the whole product claim in one line: the
     count is across every backend, because the person looking at the dock does
     not care which company's server stopped. */
  useEffect(() => {
    bridge.setBadge(waiting || null);
  }, [waiting]);

  const row = rows.find((r) => r.id === selected) ?? rows[0];

  useEffect(() => {
    bridge.setTitle(row ? `${row.name} — ${row.backend.org}` : "Firetower");
  }, [row]);

  if (path.startsWith("/style")) return <StylePage />;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-ground text-text">
      <Titlebar row={row} waiting={waiting} onPalette={() => setPalette(true)} />
      <div className="flex min-h-0 flex-1">
        <ServerStrip scope={scope} onScope={setScope} />
        <Inbox scope={scope} selected={row?.id} onSelect={setSelected} />
        {row ? <Session row={row} /> : <Empty />}
      </div>
      <Palette open={palette} onClose={() => setPalette(false)} onSelect={setSelected} />
    </div>
  );
}

function Empty() {
  return (
    <div className="grid flex-1 place-items-center text-dim">
      <p className="text-body">Nothing running.</p>
    </div>
  );
}
