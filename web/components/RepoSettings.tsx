"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Foot, Go, Quiet } from "./Modal";
import {
  useUpdateRepo,
  usePutRepoEnv,
  useRemoveRepoEnv,
  getListReposQueryKey,
} from "@/src/api/generated/repos/repos";
import { useRevealSecret } from "@/src/api/generated/secrets/secrets";
import type { Repo } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/** Where a repository's variables live in the vault. Mirrors `env_scope`. */
const scopeOf = (repo: Repo) => `repo:${repo.id}`;

/**
 * What a repository does before an agent starts, and what it starts with.
 *
 * Both live here because they are the same decision from the same person on the
 * same afternoon: this repository needs `npm ci` and a `DATABASE_URL`, or it
 * cannot do anything. Until now neither could be set at all — `setup` was in
 * the model with nothing to write it.
 */
export function RepoSettings({ repo, onClose }: { repo: Repo; onClose: () => void }) {
  const [setup, setSetup] = useState(repo.setup ?? "");
  const [writesFile, setWritesFile] = useState(repo.envFile != null);
  const [file, setFile] = useState(repo.envFile ?? ".env");

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");

  const [shown, setShown] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);

  const queryClient = useQueryClient();
  const save = useUpdateRepo();
  const put = usePutRepoEnv();
  const remove = useRemoveRepoEnv();
  const reveal = useRevealSecret();

  const held = repo.env ?? [];
  const busy = save.isPending || put.isPending || remove.isPending;

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListReposQueryKey() });
  const problem = (e: unknown) =>
    setFailed(e instanceof ApiError ? e.message : "That didn't work.");

  /**
   * Names only, and only to show what a paste is about to store.
   *
   * The values are parsed on the server, where the quoting rules are written
   * once and tested. This is a preview, not a second implementation.
   */
  const namesIn = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.replace(/^export /, "").split("=")[0].trim())
      .filter(Boolean);

  const store = (body: { variables?: { name: string; value: string }[]; dotenv?: string }) => {
    setFailed(null);
    put.mutate(
      { id: repo.id, data: body },
      {
        onSuccess: (r) => {
          setSkipped(r.skipped);
          setName("");
          setValue("");
          setPasted("");
          setPasting(false);
          refresh();
        },
        onError: problem,
      },
    );
  };

  const saveSettings = () =>
    save.mutate(
      {
        id: repo.id,
        data: { setup, envFile: writesFile ? file.trim() || ".env" : "" },
      },
      { onSuccess: () => { refresh(); onClose(); }, onError: problem },
    );

  return (
    <Modal title={repo.slug} onClose={onClose} wide>
      <label className="eyebrow">Setup</label>
      <p className="mt-1 text-meta text-mute">
        Runs in the workspace before the agent starts, with the variables below.
      </p>
      <input
        value={setup}
        onChange={(e) => setSetup(e.target.value)}
        placeholder="npm ci && npm run db:migrate"
        className="mt-2 w-full rounded-sm border border-line bg-ground px-2.5 py-1.5 font-mono text-meta text-text outline-none focus:border-dim/50"
      />

      <div className="mt-5 border-t border-line pt-4">
        <label className="eyebrow">Environment</label>
        <p className="mt-1 text-meta leading-[1.5] text-mute">
          Given to the agent and to everything it runs. Stored encrypted, and read
          once per session — but the agent can print them, so these are credentials
          it is allowed to use rather than secrets kept from it.
        </p>

        <div className="mt-3 flex flex-col">
          {held.map((n) => (
            <div key={n} className="flex items-center gap-3 border-b border-line-soft py-1.5">
              <span className="font-mono text-meta text-bone">{n}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-mute">
                {shown[n] ?? "••••••••••••"}
              </span>
              <button
                onClick={() =>
                  reveal.mutate(
                    { scope: scopeOf(repo), name: n },
                    {
                      onSuccess: (r) => setShown((s) => ({ ...s, [n]: r.value })),
                      onError: problem,
                    },
                  )
                }
                className="text-meta text-mute transition-colors hover:text-bone"
              >
                {shown[n] ? "shown" : "Reveal"}
              </button>
              <button
                onClick={() =>
                  remove.mutate(
                    { id: repo.id, name: n },
                    { onSuccess: refresh, onError: problem },
                  )
                }
                className="text-meta text-mute transition-colors hover:text-bone"
              >
                Remove
              </button>
            </div>
          ))}

          {held.length === 0 && (
            <p className="py-1.5 text-meta text-mute">Nothing yet.</p>
          )}
        </div>

        {pasting ? (
          <div className="mt-3">
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={7}
              placeholder={"DATABASE_URL=postgres://…\nexport STRIPE_KEY=\"sk_test_…\"\n# comments and blank lines are fine"}
              className="w-full rounded-sm border border-line bg-ground px-2.5 py-2 font-mono text-meta text-text outline-none focus:border-dim/50"
            />
            <div className="mt-2 flex items-center gap-3">
              <Go
                onClick={() => store({ dotenv: pasted })}
                disabled={busy || namesIn(pasted).length === 0}
              >
                {put.isPending ? "Storing…" : `Store ${namesIn(pasted).length}`}
              </Go>
              <Quiet onClick={() => { setPasting(false); setPasted(""); }}>Cancel</Quiet>
              <span className="truncate font-mono text-meta text-mute">
                {namesIn(pasted).join(" · ")}
              </span>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              placeholder="DATABASE_URL"
              className="w-[40%] rounded-sm border border-line bg-ground px-2.5 py-1.5 font-mono text-meta text-text outline-none focus:border-dim/50"
            />
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="value"
              className="min-w-0 flex-1 rounded-sm border border-line bg-ground px-2.5 py-1.5 font-mono text-meta text-text outline-none focus:border-dim/50"
            />
            <Go
              onClick={() => store({ variables: [{ name: name.trim(), value }] })}
              disabled={busy || !name.trim() || !value}
            >
              Add
            </Go>
            <Quiet onClick={() => setPasting(true)}>Paste a .env</Quiet>
          </div>
        )}

        {skipped.length > 0 && (
          <ul className="mt-3 rounded-md border border-line bg-raise px-2.5 py-1.5">
            {skipped.map((s) => (
              <li key={s} className="text-meta text-bone">
                {s}
              </li>
            ))}
          </ul>
        )}

        <label className="mt-4 flex items-center gap-2 text-meta text-dim">
          <input
            type="checkbox"
            checked={writesFile}
            onChange={(e) => setWritesFile(e.target.checked)}
            className="accent-bone"
          />
          Also write them to a file in the workspace
        </label>
        {writesFile && (
          <div className="mt-2 flex items-center gap-2">
            <input
              value={file}
              onChange={(e) => setFile(e.target.value)}
              placeholder=".env"
              className="w-[220px] rounded-sm border border-line bg-ground px-2.5 py-1.5 font-mono text-meta text-text outline-none focus:border-dim/50"
            />
            <span className="text-meta text-mute">
              written before setup runs, and kept out of git
            </span>
          </div>
        )}
      </div>

      {failed && (
        <p className="mt-3 rounded-md border border-line bg-raise px-2.5 py-1.5 text-meta text-bone">
          {failed}
        </p>
      )}

      <Foot>
        <Go onClick={saveSettings} disabled={busy}>
          {save.isPending ? "Saving…" : "Save"}
        </Go>
        <Quiet onClick={onClose}>Close</Quiet>
      </Foot>
    </Modal>
  );
}
