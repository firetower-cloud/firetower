/**
 * A fresh server, set up from the Mac.
 *
 * `setup_state` says what is still outstanding and this asks for it, then calls
 * `complete_setup`. The GitHub step the web offers here is skipped: it lives in
 * Configuration and is one click away.
 *
 * **The password step is not here.** A password that came from a file is
 * replaced on the control plane's own interface, like every other password in
 * the product, and `Gate` sends people there before this screen is reached.
 * Which also means `needsOrganization` is the only question left: naming an
 * organisation is refused by the server while a password is outstanding, so
 * this screen could never have been the one to ask both.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { getSetupStateQueryKey, useCompleteSetup, useNameOrganization, useSetupState } from "~/api/generated/setup/setup";

import { why } from "~/data";

export function Setup({ onDone }: { onDone: () => void }) {
  const cache = useQueryClient();
  const state = useSetupState();
  const name = useNameOrganization();
  const complete = useCompleteSetup();
  const [org, setOrg] = useState("");
  const refresh = () => cache.invalidateQueries({ queryKey: getSetupStateQueryKey() });

  if (state.isPending) return <Frame><p className="flex items-center gap-2 text-read text-mute"><Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />Asking what is left to do…</p></Frame>;
  if (state.error) return <Frame><p className="text-read text-brick">{why(state.error)}</p></Frame>;
  const s = state.data!;

  if (s.needsOrganization) {
    return (
      <Frame>
        <h1 className="text-display text-bone">Name the organisation</h1>
        <p className="mt-2 text-read text-dim">What the people who run this Firetower call themselves. It is what this Mac will show in the strip.</p>
        <input autoFocus value={org} onChange={(e) => setOrg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && org.trim() && name.mutate({ data: { name: org.trim() } }, { onSuccess: refresh })} placeholder="Westlabs" className="mt-5 w-full rounded-xl border border-line bg-panel px-4 py-2.5 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none" />
        {name.error && <p className="mt-2 text-meta text-brick">{why(name.error)}</p>}
        <button disabled={!org.trim() || name.isPending} onClick={() => name.mutate({ data: { name: org.trim() } }, { onSuccess: refresh })} className="control mt-4 w-full justify-center bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{name.isPending ? "Naming…" : "Continue"}</button>
      </Frame>
    );
  }

  return (
    <Frame>
      <Check className="h-6 w-6 text-sage" strokeWidth={2} />
      <h1 className="mt-3 text-display text-bone">{s.organization?.name ?? "This Firetower"} is set up</h1>
      <p className="mt-2 text-read text-dim">Connect GitHub and add a machine in Configuration when you are ready. Nothing else is needed to start.</p>
      <button disabled={complete.isPending} onClick={() => complete.mutate(undefined as never, { onSuccess: () => { refresh(); onDone(); } })} className="control mt-5 w-full justify-center bg-bone font-medium text-ground hover:opacity-90 disabled:bg-raise disabled:text-mute">{complete.isPending ? "Finishing…" : "Open the dashboard"}</button>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full min-w-0 flex-1 place-items-center bg-ground px-6"><div className="w-full max-w-[26rem]">{children}</div></div>;
}
