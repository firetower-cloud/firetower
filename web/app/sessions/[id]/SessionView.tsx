"use client";

import { usePathname } from "next/navigation";
import { Workspace } from "@/components/workspace/Workspace";

/**
 * The id, taken from the address bar rather than from the router.
 *
 * The interface ships as a static export embedded in the control plane, and an
 * export has to know every path when it is built. Session ids do not exist
 * then, so this route is written once under the placeholder segment `_` and the
 * control plane serves that one shell for every session — see `web.rs`. Reading
 * the router's parameter would therefore answer with the placeholder rather
 * than the session actually being looked at, on the deployment that matters
 * most. The address bar is always right.
 */
function useSessionId(): string {
  const pathname = usePathname();
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return decodeURIComponent(last);
}

/**
 * A link to one session opens the workbench with that session on top.
 *
 * This route used to be the session — a page of its own, with the fleet a
 * navigation away. It is now an entry point into the same workbench `/` shows,
 * because a link from a notification should land you somewhere you can keep
 * working rather than somewhere you have to leave.
 */
export default function SessionView() {
  const id = useSessionId();
  // `_` is the placeholder the export writes. Reaching this component with it
  // means a build artefact was opened directly rather than a real session.
  return <Workspace initialSession={id && id !== "_" ? id : undefined} />;
}
