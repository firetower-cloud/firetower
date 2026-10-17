"use client";

/**
 * What the organisation is, rather than who is in it.
 *
 * The name used to be edited in place in the heading above the tabs, which put
 * a control in the one piece of furniture on the page that is meant to say
 * where you are. It also left this section with three rooms about people and
 * nowhere to put the fourth thing that is plainly a setting.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getMeQueryKey, useMe } from "@/src/api/generated/auth/auth";
import { useRenameOrganization } from "@/src/api/generated/organization/organization";
import { ApiError } from "@/src/api/http";
import { useBootstrap } from "@/src/api/generated/meta/meta";
import {
  getPreviewQueryKey,
  usePreview,
  useSetTelemetrySettings,
} from "@/src/api/generated/telemetry/telemetry";
import { Confirm, type Ask } from "@/components/Confirm";
import { Badge, Button, Input, Panel } from "@/components/ui";
import { Trouble } from "./Shared";

const why = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work.");

export function Settings() {
  const { data: me } = useMe();

  return (
    <div className="max-w-[44rem] space-y-4">
      <Name current={me?.organization?.name ?? ""} />
      <ThisServer />
      <Telemetry />
    </div>
  );
}

function Name({ current }: { current: string }) {
  const cache = useQueryClient();
  const rename = useRenameOrganization();
  const [typed, setTyped] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // `null` until somebody types, so the field follows the server until it is
  // being edited and then stops — rather than being reset under the cursor by
  // a refetch that landed mid-sentence.
  const value = typed ?? current;
  const changed = value.trim() !== current && value.trim().length > 0;

  const save = () =>
    rename.mutate(
      { data: { name: value.trim() } },
      {
        onSuccess: () => {
          setTyped(null);
          setSaved(true);
          setTimeout(() => setSaved(false), 1600);
          void cache.invalidateQueries({ queryKey: getMeQueryKey() });
        },
      },
    );

  return (
    <Panel>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-ui font-medium text-bone">Name</h2>
        <p className="mt-0.5 text-meta text-mute">
          What the desktop and mobile apps show for this server, and what somebody sees before they
          sign in.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3.5">
        <Input
          value={value}
          onChange={setTyped}
          placeholder="The organisation"
          className="min-w-0 flex-1 sm:max-w-[22rem]"
          onKeyDown={(e) => e.key === "Enter" && changed && save()}
        />
        <Button variant="primary" disabled={!changed || rename.isPending} onClick={save}>
          {rename.isPending ? "Saving…" : saved ? "Saved" : "Save"}
        </Button>
      </div>
      {rename.error ? <Trouble>{why(rename.error)}</Trouble> : null}
    </Panel>
  );
}

/**
 * What this installation reports about itself, and the switch for it.
 *
 * Here rather than in the desktop app, and per organisation rather than per
 * person: one switch for the whole install, so turning it off means off rather
 * than off-for-me-but-not-my-colleagues. An administrator changes it; everybody
 * else can read it, which is the point — somebody who cannot change a thing
 * being collected about them should at least be able to see that it is.
 *
 * The whole panel is built from `/telemetry/preview`, deliberately. It answers
 * the state, the destination, the backlog and the actual document in one
 * request, so no two parts of this can disagree about what is being sent. It is
 * also computed on demand rather than read out of the outbox, so it answers on
 * an install where collection is off and there is nothing queued — which is
 * exactly the state somebody deciding whether to turn it on is in.
 */
/**
 * What this installation reports about itself, and the switch for it.
 *
 * Here rather than in the desktop app, and per organisation rather than per
 * person: one switch for the whole install, so turning it off means off rather
 * than off-for-me-but-not-my-colleagues. An administrator changes it; everybody
 * else can read it, which is the point — somebody who cannot change a thing
 * being collected about them should at least be able to see that it is.
 *
 * The whole panel is built from `/telemetry/preview`, deliberately. It answers
 * the state, the destination, the backlog and the actual document in one
 * request, so no two parts of this can disagree about what is being sent. It is
 * also computed on demand rather than read out of the outbox, so it answers on
 * an install where collection is off and there is nothing queued — which is
 * exactly the state somebody deciding whether to turn it on is in.
 *
 * **A button at the foot rather than a tick beside a label.** A checkbox is for
 * a preference among several, read left to right and set on the way past. This
 * is one decision about the whole panel above it, and it reads in the order it
 * should be made: what is collected, where it goes, what is actually sent, and
 * only then the button. Red in one direction and not the other, because only
 * one direction is worth a second thought.
 */
function Telemetry() {
  const { data: me } = useMe();
  const admin = me?.user.role === "admin";
  const cache = useQueryClient();
  const { data } = usePreview();
  const set = useSetTelemetrySettings();
  const [showing, setShowing] = useState(false);
  const [asking, setAsking] = useState<Ask | null>(null);

  const on = data?.enabled ?? true;

  const save = (enabled: boolean) =>
    set.mutateAsync(
      { data: { enabled } },
      { onSuccess: () => void cache.invalidateQueries({ queryKey: getPreviewQueryKey() }) },
    );

  /**
   * Turning it on is one click. Turning it off asks, and has to be typed.
   *
   * Asymmetric on purpose: it is the one direction worth a sentence, because
   * somebody who has read what is actually collected — one click away, above —
   * usually leaves it on. Typing the words is so it cannot be done by clicking
   * twice in the same place.
   *
   * It still goes through. This is a question, not a wall.
   *
   * One sentence, and the asking is the whole of it. What turning it off
   * actually does is said at the foot of the panel instead, where it is
   * readable before the dialog is ever opened.
   */
  const turnOff = () =>
    setAsking({
      title: "Turn telemetry off?",
      body: (
        <p>
          Firetower is free to use and open source, and telemetry is crucial for our future
          development. Are you sure you want to turn it off?
        </p>
      ),
      action: "Turn it off",
      tone: "danger",
      confirmWith: "TURN IT OFF",
      run: () => save(false),
    });

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-ui font-medium text-bone">Telemetry</h2>
          <p className="mt-0.5 text-meta text-mute">
            Daily counts about this installation, so we can tell how Firetower is actually used.
          </p>
        </div>
        <Badge tone={on ? "sage" : "brick"}>{on ? "On" : "Off"}</Badge>
      </div>

      <div className="space-y-3 px-4 py-3.5">
        {/* Said plainly, because the honest list is short and reads better than
            a reassurance would. */}
        <p className="text-meta text-mute">
          What goes: how many people used Firetower, how many workspaces and sessions ran, which
          agents and trackers, how many machines, and which versions. What never goes: your code,
          your prompts, repository or branch names, task titles, account names, and anything that
          identifies an individual person — there is no per-person record in it at all.
        </p>

        <dl className="divide-y divide-line-soft border-t border-line-soft">
          <Fact term="Goes to">
            <span className="break-all font-mono text-meta text-bone">{data?.endpoint ?? "—"}</span>
          </Fact>
          <Fact term="Sent by">
            <span className="text-meta text-mute">
              The desktop app, next time somebody opens it. This server never connects out.
            </span>
          </Fact>
          {on ? (
            <Fact term="Waiting">
              <span className="text-meta text-mute">
                {data ? `${data.waiting} ${data.waiting === 1 ? "day" : "days"}` : "—"}
              </span>
            </Fact>
          ) : null}
        </dl>

        <div>
          <Button variant="quiet" onClick={() => setShowing(!showing)}>
            {showing ? "Hide" : "Show exactly what is sent"}
          </Button>
          {showing ? (
            <pre className="mt-2 max-h-80 overflow-auto rounded border border-line bg-ground p-3 font-mono text-meta text-dim">
              {JSON.stringify(data?.example ?? {}, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>

      {set.error ? <Trouble>{why(set.error)}</Trouble> : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
        <p className="min-w-0 text-meta text-mute">
          {!admin
            ? "Only an administrator can change this."
            : on
              ? "Turning it off also discards anything computed and not yet sent."
              : "Nothing is being collected or sent."}
        </p>
        {on ? (
          <Button variant="danger" disabled={!admin || set.isPending} onClick={turnOff}>
            {set.isPending ? "Working…" : "Turn telemetry off"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!admin || set.isPending}
            onClick={() => void save(true)}
          >
            {set.isPending ? "Working…" : "Turn telemetry on"}
          </Button>
        )}
      </div>

      <Confirm ask={asking} onClose={() => setAsking(null)} />
    </Panel>
  );
}

/**
 * What this installation is running, and how it lets people in.
 *
 * The id used to be here, on the grounds that a client pins its token to it.
 * True, and useless: nobody reads an id off a settings page to solve anything,
 * and it sat where the two questions an administrator does ask should be —
 * *what version is this* and *why is there (or is there not) a password form*.
 *
 * Both come from `/bootstrap`, which is the one endpoint that answers before
 * anybody has signed in, and therefore the one that already knows.
 */
function ThisServer() {
  const { data } = useBootstrap();

  return (
    <Panel>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-ui font-medium text-bone">This server</h2>
        <p className="mt-0.5 text-meta text-mute">
          What is running here, and what it asks of somebody signing in.
        </p>
      </div>
      <dl className="divide-y divide-line-soft">
        <Fact term="Version">
          {data ? <span className="font-mono text-meta text-bone">{data.version}</span> : "—"}
        </Fact>
        <Fact term="Signing in">
          <span className="flex flex-wrap items-center gap-2">
            {(data?.authModes ?? []).map((mode) => (
              <Badge key={mode} tone={mode === "open" ? "brick" : "neutral"}>
                {SIGN_IN[mode]?.label ?? mode}
              </Badge>
            ))}
            <span className="text-meta text-mute">
              {data?.authModes?.map((m) => SIGN_IN[m]?.says).filter(Boolean).join(" ")}
            </span>
          </span>
        </Fact>
      </dl>
    </Panel>
  );
}

/**
 * The three ways in, in words.
 *
 * `open` is a badge in brick because it is not a setting so much as a warning:
 * anything that can reach the port is in, and an installation that got there by
 * accident should find out here rather than from somebody else.
 */
const SIGN_IN: Record<string, { label: string; says: string }> = {
  password: { label: "Password", says: "A username and a password, kept here." },
  proxy: {
    label: "Trusted proxy",
    says: "Identity comes from whatever sits in front of this server.",
  },
  open: {
    label: "Nothing",
    says: "Anyone who can reach the port is in. Only ever right on a laptop.",
  },
};

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3">
      <dt className="w-[7rem] shrink-0 text-ui text-dim">{term}</dt>
      <dd className="min-w-0 flex-1 text-ui text-text">{children}</dd>
    </div>
  );
}
