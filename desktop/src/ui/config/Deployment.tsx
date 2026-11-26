/**
 * The installation itself: what it is called, what it reports, what is running
 * on it, and how it lets people in.
 *
 * **It was two panes' worth of different subjects under one heading.** The
 * renderer's *This Firetower* carried the deployment's version beside the
 * address this Mac reached it on, who you are signed in as, and a Disconnect —
 * three facts about *you and this window*, which `destinations.ts` says belong
 * to the profile menu, and which the Account screen already draws for
 * everybody, Forget included. Those are gone from here rather than duplicated
 * a third time; what is left is the organisation's installation, which is why
 * this pane can be an administrator's at all.
 *
 * ## Three of this ticket's four named capabilities did not exist
 *
 * The approved specification's F3 names single sign-on configuration, password
 * policy, trusted-proxy configuration and deployment settings. Established by
 * enumerating every write endpoint in the API: **only the last exists.** The
 * password minimum is `const MINIMUM_PASSWORD: usize = 5`, compiled in. Single
 * sign-on and the trusted proxy are `FIRETOWER_AUTH`,
 * `FIRETOWER_TRUSTED_PROXY_HEADER` and `FIRETOWER_TRUSTED_PROXY` — environment
 * variables read once by `auth::load()` at boot into an immutable policy. There
 * is no settings table in any migration, and the administration site has no
 * screen for any of the three either.
 *
 * So this moves what exists — the name and telemetry — and **reads back** the
 * sign-in configuration rather than pretending to set it. Making those three
 * editable is not an endpoint: it needs somewhere to store them, a way to apply
 * them without a restart, and for the proxy pair an interface that can lock
 * every administrator out of the control plane. That is authentication work,
 * which this run is fenced off from.
 *
 * ## What the sign-in panel may say, and what it may not
 *
 * **The client is never told the values**, and that settles most of it:
 * `/bootstrap` carries `authModes` — the *result* of the policy — and not the
 * header name or the trusted address list. Printing those would need an API
 * change, which is the thing this pane exists to avoid inventing. So it names
 * the three variables so an operator knows where to look, says which modes the
 * server actually accepts, and says plainly that the two proxy values are not
 * sent here rather than leaving a blank somebody reads as *unset*.
 *
 * **The fail-closed case is not drawn**, deliberately: `auth::load()` refuses
 * to start when a header is trusted from nowhere, so a server a client can
 * reach is by construction not in that state. A panel that drew it would be
 * drawing a state it can never observe.
 *
 * **`open` is the one state worth saying loudly**, and it is said in brick
 * rather than ember — ember means an agent is waiting on you. It is also
 * narrower than it looks: start-up refuses an open policy on anything but a
 * loopback bind, so an installation that got here by accident is one somebody
 * can still reach only from the machine it runs on.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button } from "~/components/ui";
import { useMe } from "~/api/generated/auth/auth";
import { useBootstrap } from "~/api/generated/meta/meta";
import { useRenameOrganization } from "~/api/generated/organization/organization";
import { getPreviewQueryKey, usePreview, useSetTelemetrySettings } from "~/api/generated/telemetry/telemetry";
import { why } from "~/data";
import { useConfirm } from "~/ui/Confirm";
import { Facts, Section } from "~/ui/config/bits";

/**
 * The three ways in, in words.
 *
 * `open` reads in brick because it is not a setting so much as a warning:
 * anything that can reach the port is in, and an installation that got there
 * by accident should find out here rather than from somebody else.
 */
const SIGN_IN: Record<string, { label: string; says: string; loud?: boolean }> = {
  password: { label: "Password", says: "A username and a password, kept here." },
  proxy: {
    label: "Trusted proxy",
    says: "Identity comes from whatever sits in front of this server.",
  },
  open: {
    label: "Nothing",
    says: "Anyone who can reach the port is in. Start-up allows this on a loopback address only.",
    loud: true,
  },
};

/**
 * The three variables that decide it, and what each one does.
 *
 * Prose, with no markup in it: the first of these read *"Set it to `none`"*
 * and the backticks came out as backticks, because nothing on this pane runs
 * a formatter over a string. A value worth setting apart goes in `<Mono>`
 * where it is drawn, not in a notation nothing reads.
 */
const DECIDED_BY: { name: string; says: React.ReactNode }[] = [
  {
    name: "FIRETOWER_AUTH",
    says: (
      <>
        Set it to <Mono>none</Mono> and no password is asked for.
      </>
    ),
  },
  {
    name: "FIRETOWER_TRUSTED_PROXY_HEADER",
    says: "The header a proxy in front sets to say who the request is from.",
  },
  {
    name: "FIRETOWER_TRUSTED_PROXY",
    says: "Which addresses that header is believed from. Addresses or CIDR blocks.",
  },
];

/** A value, where the individual characters carry meaning. */
function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-bone">{children}</span>;
}

export function Deployment() {
  const boot = useBootstrap({ query: { staleTime: 60_000 } });
  const modes = boot.data?.authModes ?? [];

  return (
    <Section
      title="This Firetower"
      note="The installation everybody here signs in to — what it is called, what it reports, and how it lets people in."
    >
      <Name />
      <Telemetry />

      <section className="lsec">
        <h2>What is running</h2>
        <Facts of={[["Version", boot.data?.version ?? "—", true]]} />
      </section>

      <section className="lsec">
        <h2>How signing in works here</h2>
        <p className="note">
          Read here and set where the server starts. These are not stored, so there is nothing on
          this screen to change — the three names below are where an operator changes them.
        </p>
        <Facts
          of={[
            [
              "Accepted",
              <span key="modes" className="flex flex-wrap items-center gap-2">
                {modes.length === 0 && "—"}
                {modes.map((m) => (
                  <Badge key={m} tone={SIGN_IN[m]?.loud ? "brick" : "neutral"}>
                    {SIGN_IN[m]?.label ?? m}
                  </Badge>
                ))}
              </span>,
            ],
            ...modes.map(
              (m) => [SIGN_IN[m]?.label ?? m, SIGN_IN[m]?.says ?? "—"] as [string, React.ReactNode],
            ),
          ]}
        />
        <div className="lrows mt-3">
          {DECIDED_BY.map((v) => (
            <div key={v.name} className="r">
              <span className="tx">
                <b className="font-mono">{v.name}</b>
                <s>{v.says}</s>
              </span>
            </div>
          ))}
        </div>
        {/* Said rather than left blank. An empty value here reads as *unset*,
            which is a different and much worse thing to believe about a proxy
            than *not told*. */}
        <p className="mt-2 text-meta text-mute">
          The last two are never sent to a client, so their values are not shown here. What the
          server accepts because of them is above.
        </p>
      </section>
    </Section>
  );
}

/**
 * What the people who run it call it.
 *
 * One field, saved on Enter or on the button, with the server's own refusal
 * underneath. It is the organisation's rather than the deployment's, strictly
 * — but it is the one thing on this pane a hosted tenant would still own, and
 * it is one field, so it sits here rather than becoming a pane of its own.
 */
function Name() {
  const me = useMe();
  const cache = useQueryClient();
  const rename = useRenameOrganization();
  const current = me.data?.organization?.name ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const value = draft ?? current;
  const changed = value.trim() !== "" && value.trim() !== current;

  const save = () => {
    if (!changed || rename.isPending) return;
    setSaid(null);
    rename
      .mutateAsync({ data: { name: value.trim() } })
      .then(() => {
        setDraft(null);
        return cache.invalidateQueries();
      })
      .catch((e) => setSaid(why(e)));
  };

  return (
    <section className="lsec">
      <h2>Name</h2>
      <p className="note">
        What this Firetower is called, wherever it names itself — the sign-in screen, the rail, and
        the window somebody opens on a machine that has never seen it.
      </p>
      <div className="card1 flex flex-wrap items-center gap-3">
        <input
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setDraft(null);
          }}
          aria-label="What this Firetower is called"
          placeholder="Acme"
          spellCheck={false}
          className="w-64 rounded-md border border-line bg-ground px-2 py-1 text-ui text-bone focus:border-dim focus:outline-none"
        />
        <Button disabled={!changed || rename.isPending} onClick={save}>
          {rename.isPending ? "Saving…" : "Save"}
        </Button>
        {said ? (
          <span className="aside1 !text-brick">{said}</span>
        ) : (
          /* Only once something has actually changed. A row that says *renaming
             takes nothing away* at rest is a sentence about an action nobody
             has started. */
          changed && <span className="aside1">Renaming moves nothing and takes nothing away.</span>
        )}
      </div>
    </section>
  );
}

/**
 * Daily counts about this installation.
 *
 * **Asymmetric, and that half of the web's decision is kept**: turning it on
 * is one click, turning it off asks. It is the one direction worth a sentence,
 * because somebody who has read what is actually collected — one click away,
 * below — usually leaves it on. It still goes through; this is a question, not
 * a wall.
 *
 * **What is not kept is the typed confirmation.** The administration site made
 * somebody type `TURN IT OFF`. Nothing in this client requires typing to
 * confirm anything — not removing a person, not deleting a team, both of which
 * destroy something — so porting it would have made switching off a daily
 * counter the most guarded act in the window. The ticket is explicit that these
 * follow the panes already here rather than the administration site's.
 */
function Telemetry() {
  const cache = useQueryClient();
  const confirm = useConfirm();
  const q = usePreview();
  const set = useSetTelemetrySettings();
  const [showing, setShowing] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const on = q.data?.enabled ?? true;
  const waiting = q.data?.waiting ?? 0;

  const save = (enabled: boolean) => {
    setSaid(null);
    set
      .mutateAsync({ data: { enabled } })
      .then(() => cache.invalidateQueries({ queryKey: getPreviewQueryKey() }))
      .catch((e) => setSaid(why(e)));
  };

  return (
    <section className="lsec">
      <h2>
        Telemetry
        <span className="n">{on ? "on" : "off"}</span>
      </h2>
      <p className="note">
        Daily counts about this installation, so the people who build Firetower can tell how it is
        actually used.
      </p>

      {/* Two sentences: the promise, then the reason. The exhaustive version of
          both is one click away under *Show exactly what is sent*, which is the
          copy that cannot drift from the truth — it is the document. */}
      <p className="mt-2 max-w-[68ch] text-ui leading-relaxed text-dim">
        Nothing that could identify a person is ever sent — no prompts, no task names, nothing
        sensitive. It says which versions people are running and how usage is growing.
      </p>

      <Facts
        of={[
          ["Goes to", <span key="to" className="font-mono">{q.data?.endpoint ?? "—"}</span>],
          [
            "Sent by",
            "The desktop app, next time somebody opens it. This server never connects out.",
          ],
          ...(on
            ? ([["Waiting", `${waiting} ${waiting === 1 ? "day" : "days"}`]] as [string, React.ReactNode][])
            : []),
        ]}
      />

      <div className="card1 mt-3 flex flex-wrap items-center gap-3">
        <Button variant="quiet" onClick={() => setShowing((v) => !v)}>
          {showing ? "Hide" : "Show exactly what is sent"}
        </Button>
        <span className="aside1">
          {said ??
            (on
              ? "Turning it off also discards anything computed and not yet sent."
              : "Nothing is being collected or sent.")}
        </span>
        {on ? (
          <Button
            variant="danger"
            className="ml-auto"
            disabled={set.isPending}
            onClick={() =>
              void confirm({
                title: "Turn telemetry off?",
                body: "Firetower is free and open source, and these counts are most of how its authors can tell what is worth building. Nothing identifying is in them.",
                action: "Turn it off",
                tone: "danger",
              }).then((ok) => ok && save(false))
            }
          >
            {set.isPending ? "Working…" : "Turn telemetry off"}
          </Button>
        ) : (
          <Button variant="primary" className="ml-auto" disabled={set.isPending} onClick={() => save(true)}>
            {set.isPending ? "Working…" : "Turn telemetry on"}
          </Button>
        )}
      </div>

      {showing && (
        <pre className="scroll-slim mt-2 max-h-80 overflow-auto rounded-xl border border-line bg-ground p-3 font-mono text-meta text-dim">
          {JSON.stringify(q.data?.example ?? {}, null, 2)}
        </pre>
      )}
    </section>
  );
}
