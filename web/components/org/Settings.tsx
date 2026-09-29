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
import { Badge, Button, Input, Panel } from "@/components/ui";
import { Trouble } from "./Shared";

const why = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work.");

export function Settings() {
  const { data: me } = useMe();

  return (
    <div className="max-w-[44rem] space-y-4">
      <Name current={me?.organization?.name ?? ""} />
      <ThisServer />
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
