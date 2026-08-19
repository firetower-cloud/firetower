"use client";

import { useState } from "react";
import { useChangePassword } from "@/src/api/generated/auth/auth";
import { useNameOrganization } from "@/src/api/generated/setup/setup";
import { useSetClientId } from "@/src/api/generated/providers/providers";
import { ApiError, rememberToken } from "@/src/api/http";

/**
 * The parts of setting up that only a person can answer.
 *
 * Replacing a password that came from a file, naming the organisation, and —
 * optionally, and skippably — registering a GitHub application. Everything
 * after this is the tour, which asks for nothing.
 */

/* ── replacing the password ────────────────────────────────────────── */

export function StepPassword({ onNext }: { onNext: () => void }) {
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
      <h1 className="text-[20px] font-semibold text-bone">Choose a password</h1>
      <p className="mt-2 max-w-[54ch] text-[13.5px] leading-[1.6] text-dim">
        The one you signed in with came from a file on the server, where anyone
        who can read that file can read it. Replace it and it stops mattering
        who has seen it — then delete{" "}
        <code className="font-mono text-[12.5px] text-slate">
          ADMIN_INITIAL_PASSWORD
        </code>{" "}
        from that file.
      </p>

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
          <p className="mt-3 text-[12.5px] text-ember" role="alert">
            {failed}
          </p>
        )}

        <button
          type="submit"
          disabled={change.isPending || !current || next.length < 5}
          className="mt-5 rounded bg-ember px-3.5 py-2 text-[13px] font-medium text-ink disabled:opacity-40"
        >
          {change.isPending ? "Saving…" : "Save and continue"}
        </button>
      </form>

      <p className="mt-4 text-[12px] text-mute">
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
      <h1 className="text-[20px] font-semibold text-bone">
        What should this be called?
      </h1>
      <p className="mt-2 max-w-[54ch] text-[13.5px] leading-[1.6] text-dim">
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
          <p className="mt-3 text-[12.5px] text-ember" role="alert">
            {failed}
          </p>
        )}
        <button
          type="submit"
          disabled={name_it.isPending || !name.trim()}
          className="mt-5 rounded bg-ember px-3.5 py-2 text-[13px] font-medium text-ink disabled:opacity-40"
        >
          {name_it.isPending ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

/* ── the optional one ──────────────────────────────────────────────── */

export function StepGitHub({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <h1 className="text-[20px] font-semibold text-bone">
        Connect GitHub — optional
      </h1>
      <p className="mt-2 max-w-[56ch] text-[13.5px] leading-[1.6] text-dim">
        With an application registered, you can authorize GitHub once and pick
        from a list of your repositories. Without one, you paste a repository&apos;s
        URL and the machine&apos;s own git credentials are used — which works, and
        is why this is skippable.
      </p>

      <div className="mt-6 max-w-[420px]">
        <ClientIdForm onDone={onNext} />
      </div>

      <button
        onClick={onNext}
        className="mt-6 text-[13px] text-mute hover:text-text"
      >
        Skip — do this later
      </button>
    </div>
  );
}

/**
 * Asked here, and again on the connect screen at the moment it is missed.
 *
 * Both places use this, so the four steps and the warning about the checkbox
 * are written once.
 */
export function ClientIdForm({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const save = useSetClientId();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailed(null);
    save.mutate(
      { id: "github", data: { clientId: value } },
      {
        onSuccess: () => onDone(),
        onError: (error) =>
          setFailed(
            error instanceof ApiError ? error.message : "That didn't work.",
          ),
      },
    );
  };

  return (
    <div>
      <ol className="space-y-1.5 text-[12.5px] leading-[1.6] text-dim">
        <li>
          1. Open{" "}
          <a
            href="https://github.com/settings/applications/new"
            target="_blank"
            rel="noreferrer"
            className="text-ember hover:underline"
          >
            github.com/settings/applications/new
          </a>
        </li>
        <li>
          2. Name it <span className="text-slate">Firetower</span>. The homepage
          URL can be anything; the callback URL is required by the form and
          unused by this flow.
        </li>
        <li>
          3. Register it, then tick{" "}
          <span className="text-slate">Enable Device Flow</span> and update.
          <span className="text-mute">
            {" "}
            Don&apos;t skip this — it is off by default, below the fold, and
            without it every authorization fails with the same error as a wrong
            identifier.
          </span>
        </li>
        <li>4. Copy the Client ID from the top of that page.</li>
      </ol>

      <form onSubmit={submit} className="mt-4">
        <Field
          id="client-id"
          label="Client ID"
          hint="Looks like Ov23li… — public by design, with no paired secret."
          value={value}
          onChange={setValue}
        />
        {failed && (
          <p className="mt-3 text-[12.5px] text-ember" role="alert">
            {failed}
          </p>
        )}
        <button
          type="submit"
          disabled={save.isPending || !value.trim()}
          className="mt-4 rounded bg-ember px-3.5 py-2 text-[13px] font-medium text-ink disabled:opacity-40"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}

/* ── one field, everywhere ─────────────────────────────────────────── */

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
      <label className="block text-[12px] text-mute" htmlFor={id}>
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
        className="mt-1.5 w-full rounded border border-line bg-transparent px-3 py-2 text-[13.5px] text-bone outline-none focus:border-ember"
      />
      {hint && <p className="mt-1.5 text-[11.5px] text-mute">{hint}</p>}
    </div>
  );
}
