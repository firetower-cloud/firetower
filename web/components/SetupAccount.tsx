"use client";

import { useState } from "react";
import { useChangePassword } from "@/src/api/generated/auth/auth";
import { useNameOrganization } from "@/src/api/generated/setup/setup";
import { ApiError, rememberToken } from "@/src/api/http";

/**
 * The parts of setting up that only a person can answer.
 *
 * Replacing a password that came from a file, and naming the organisation.
 * Everything after this is the tour, which asks for nothing.
 *
 * **There was a third step and it has gone to the app.** It registered a
 * GitHub application — optional and skippable, because without one you paste a
 * repository's URL and the machine's own git credentials are used. No wizard
 * ever rendered it after the web app was narrowed to administration, and the
 * capability is on the desk, in `config/SetUpClient.tsx` and `config/GitHosts.tsx`,
 * against the same `providers` endpoints. That is also where GitLab and Gitea
 * were always added, for the reason in `docs/which-surface.md`: a host is the
 * installation's, which puts it beside machines and the vault rather than in a
 * first-boot wizard here.
 */

/* ── replacing the password ────────────────────────────────────────── */

/**
 * Replacing a password, for the two different people who have to.
 *
 * `fromFile` is the install's first administrator, whose password is sitting in
 * an environment file on the server. Everybody else was handed one by an
 * administrator — invited, or reset — and telling them to go and delete
 * `ADMIN_INITIAL_PASSWORD` would be advice about a file they have never seen
 * and cannot reach.
 *
 * Both are the same form. Only the reason differs, and the reason is the half
 * that decides whether somebody believes the screen.
 */
export function StepPassword({ onNext, fromFile = true }: { onNext: () => void; fromFile?: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [failed, setFailed] = useState<string | null>(null);

  const change = useChangePassword();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailed(null);

    if (next !== again) {
      setFailed("Those two don't match.");
      return;
    }

    change.mutate(
      { data: { current, new: next } },
      {
        onSuccess: ({ token }) => {
          // Every *other* browser was signed out, and this one was handed a new
          // session. Keeping it is what lets the wizard carry on — being thrown
          // out halfway through step one was the bug this replaced.
          rememberToken(token);
          onNext();
        },
        onError: (error) =>
          setFailed(
            error instanceof ApiError ? error.message : "That didn't work.",
          ),
      },
    );
  };

  return (
    <div>
      <h1 className="text-display font-semibold text-bone">Choose a password</h1>
      {fromFile ? (
        <p className="mt-2 max-w-[54ch] text-ui leading-[1.6] text-dim">
          The one you signed in with came from a file on the server, where anyone
          who can read that file can read it. Replace it and it stops mattering
          who has seen it, then delete{" "}
          <code className="font-mono text-meta text-slate">
            ADMIN_INITIAL_PASSWORD
          </code>{" "}
          from that file.
        </p>
      ) : (
        <p className="mt-2 max-w-[54ch] text-ui leading-[1.6] text-dim">
          The one you signed in with was given to you by an administrator, who
          has seen it. Choose your own and theirs stops working.
        </p>
      )}

      <form onSubmit={submit} className="mt-6 max-w-[340px]">
        <Field
          id="current"
          label="The one you just used"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
        />
        <Field
          id="new"
          label="New password"
          hint="At least 5 characters. Nothing else is required of it."
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
        />
        <Field
          id="again"
          label="Again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={setAgain}
        />

        {failed && (
          <p className="mt-3 text-meta text-brick" role="alert">
            {failed}
          </p>
        )}

        <button
          type="submit"
          disabled={change.isPending || !current || next.length < 5}
          className="mt-5 rounded-md bg-bone px-3.5 py-2 text-ui font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
        >
          {change.isPending ? "Saving…" : "Save and continue"}
        </button>
      </form>

      <p className="mt-4 text-meta text-mute">
        Every other browser signed in as you is signed out. This one carries on.
      </p>
    </div>
  );
}

/* ── naming the organisation ───────────────────────────────────────── */

export function StepOrganization({ onNext }: { onNext: () => void }) {
  const [name, setName] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const name_it = useNameOrganization();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailed(null);
    name_it.mutate(
      { data: { name } },
      {
        onSuccess: () => onNext(),
        onError: (error) =>
          setFailed(
            error instanceof ApiError ? error.message : "That didn't work.",
          ),
      },
    );
  };

  return (
    <div>
      <h1 className="text-display font-semibold text-bone">
        What should this be called?
      </h1>
      <p className="mt-2 max-w-[54ch] text-ui leading-[1.6] text-dim">
        The name of whoever this Firetower belongs to — you, or your company. It
        is shown in the interface and nothing depends on it, so an approximate
        answer is fine.
      </p>

      <form onSubmit={submit} className="mt-6 max-w-[340px]">
        <Field
          id="organization"
          label="Organisation"
          value={name}
          onChange={setName}
          autoFocus
        />
        {failed && (
          <p className="mt-3 text-meta text-brick" role="alert">
            {failed}
          </p>
        )}
        <button
          type="submit"
          disabled={name_it.isPending || !name.trim()}
          className="mt-5 rounded-md bg-bone px-3.5 py-2 text-ui font-medium text-ground transition-colors hover:bg-white disabled:bg-line disabled:text-mute"
        >
          {name_it.isPending ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  type = "text",
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  id: string;
  label: string;
  hint?: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="mt-4 first:mt-0">
      <label className="block text-meta text-mute" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 w-full rounded border border-line bg-transparent px-3 py-2 text-ui text-bone outline-none focus:border-dim"
      />
      {hint && <p className="mt-1.5 text-meta text-mute">{hint}</p>}
    </div>
  );
}
