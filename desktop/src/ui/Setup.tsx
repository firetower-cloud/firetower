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
import { Building2, Check, Loader2 } from "lucide-react";
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
        <span className="mk">
          <Building2 className="h-6 w-6" strokeWidth={1.75} />
        </span>
        <h1>Name this Firetower</h1>
        <p>What the people who run it call themselves. It is what this Mac shows in the strip.</p>
        <label className="in">
          <input autoFocus value={org} onChange={(e) => setOrg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && org.trim() && name.mutate({ data: { name: org.trim() } }, { onSuccess: refresh })} placeholder="Westlabs" aria-label="What to call this Firetower" className="bg-transparent placeholder:text-mute focus:outline-none" />
        </label>
        {name.error && <p className="bad">{why(name.error)}</p>}
        <button disabled={!org.trim() || name.isPending} onClick={() => name.mutate({ data: { name: org.trim() } }, { onSuccess: refresh })} className="btn primary go">{name.isPending ? "Naming…" : "Continue"}</button>
      </Frame>
    );
  }

  return (
    <Frame>
      <span className="mk">
        <Check className="h-6 w-6" strokeWidth={2} />
      </span>
      <h1>{s.organization?.name ?? "This Firetower"} is set up</h1>
      <p>Connect a git host and add a machine when you are ready — both are one click away. Nothing else is needed to start.</p>
      {/* Said here because this is the last screen before the app, and an
          opt-out nobody was told about is not one. Short on purpose: the full
          list, and the switch, are one click away where the setting lives. */}
      <p className="alt !text-left">
        Firetower reports daily usage counts so we can see how it is actually used — never your
        code, your prompts or your repository names. An administrator can read exactly what is sent,
        or turn it off, under Organisation → Settings.
      </p>
      <button disabled={complete.isPending} onClick={() => complete.mutate(undefined as never, { onSuccess: () => { refresh(); onDone(); } })} className="btn primary go">{complete.isPending ? "Finishing…" : "Open Firetower"}</button>
    </Frame>
  );
}

/** The same frame the connect flow uses: on the sheet, one question at a time. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="first">
      <div className="card">{children}</div>
    </div>
  );
}
