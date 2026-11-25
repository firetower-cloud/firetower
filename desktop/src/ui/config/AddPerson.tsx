/**
 * Adding somebody, and the password that is handed over once.
 *
 * Two sheets rather than one, because they are two moments: the first asks
 * three questions, and the second exists only to carry something out of the
 * screen before it is gone. They are in one file because the second is
 * **always** reached from the first or from a reset, and splitting them would
 * put the whole of "a password is said once" in two places.
 *
 * ## Shown once, because the server keeps only a hash
 *
 * `create_user` and `reset_user_password` both answer with a plaintext password
 * and neither will answer with it again — there is nothing to ask. A screen
 * that treats that casually produces an account nobody can get into, so the
 * password is a field rather than a sentence: masked, revealable, and copyable
 * without being selected by hand.
 *
 * ### There are two routes to the clipboard, and the second one is the real one
 *
 * **`navigator.clipboard` is undefined on a non-secure origin**, and a
 * self-hoster reaching a bare address over plain http is an ordinary
 * deployment for this product — so the modern API is simply not there for a
 * large share of installations. `write()` falls through to a selection and
 * `document.execCommand("copy")`, which was driven on a real non-secure origin
 * rather than reasoned about: the clipboard genuinely receives the password,
 * `execCommand` reports it, and the button says *Copied* truthfully. With both
 * routes dead the button does **not** flash *Copied* and the line underneath
 * says so, which is the behaviour that matters — a silent success here loses
 * an account.
 *
 * **The mask is not selectable, and that is the part that was wrong.** Both
 * spans carried `select-all`, so dragging across the field while it was masked
 * put sixteen bullet characters on the clipboard with nothing to say they were
 * not a password — and the failure sentence told you to do exactly that. A
 * hand-selection can now only ever pick up the real thing, and a copy that
 * fails **reveals the password on its way to saying so**, because advice to
 * select something by hand is worth nothing against a row of dots.
 *
 * The message underneath is what somebody actually needs — a note to paste to a
 * colleague. **The password is hidden in the note on screen and whole on the
 * clipboard**, so reading over somebody's shoulder gets nothing while the paste
 * still works.
 *
 * It sends them to the Firetower itself rather than to a download. Signing in
 * is where the apps are offered, so that is one link instead of two, and the
 * order is the one that works.
 */
import { useState } from "react";
import { Check, Clipboard, Eye, EyeOff, X } from "lucide-react";
import { IconButton, Segmented } from "~/components/ui";
import { write } from "~/components/ui/Copy";
import { useCreateUser } from "~/api/generated/organization/organization";
import { useSetupState } from "~/api/generated/setup/setup";
import { why } from "~/data";
import { ROLES } from "~/ui/config/organisation";

/** A password said once, and who it is for. */
export type Handed = {
  username: string;
  password: string;
  /** A new account, or a reset. The two are the same screen and not the same
   *  sentence: one says somebody is in, the other says their old one stopped. */
  fresh: boolean;
};

export function AddPerson({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (handed: Handed) => void;
}) {
  const create = useCreateUser();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const ready = username.trim() !== "" && email.trim() !== "";

  /* The refusals are the server's and they are specific: *there is already a
     user called ana*, *ana@acme.com is already somebody's here*. Both are
     shown as the sentence the server wrote rather than reduced to "that did
     not work" — the whole value of the message is which of the two it is. */
  const go = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      { data: { username: username.trim(), email: email.trim(), role } },
      { onSuccess: (made) => onAdded({ username: made.user.username, password: made.password, fresh: true }) },
    );
  };

  return (
    <Sheet label="Add a person" title="Add a person" says="The server makes them a password and shows it to you once." onClose={onClose}>
      <div className="dbody scroll-slim">
        <div className="form">
          <label className="fld">
            <span>Username</span>
            <span className="hint">What they sign in with. It cannot be changed later.</span>
            <span className="box mono">
              <input
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && go()}
                placeholder="ana"
                spellCheck={false}
              />
            </span>
          </label>

          {/* Required from now on, and absent on the accounts that predate it.
              Nothing is invented for those: a placeholder cannot be told apart
              from a real address that bounces, which is the question that
              matters the first time anything is sent. */}
          <label className="fld">
            <span>Email</span>
            <span className="hint">Where we will write to them. One address, one account.</span>
            <span className="box">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && go()}
                placeholder="ana@acme.com"
                spellCheck={false}
              />
            </span>
          </label>

          {/* **A segmented control, which is what two mutually exclusive things
              are.** The administration site draws two bordered cards with a
              radio dot and a paragraph in each, which is a lot of furniture for
              a choice between two words — and the reason to pick one is a
              sentence that only matters for whichever is chosen, so it reads
              underneath as a consequence rather than twice as a comparison. */}
          <div role="group" aria-label="Role" className="fld">
            <span>Role</span>
            <Segmented
              className="flex self-start"
              label="Role"
              value={role}
              onChange={setRole}
              options={ROLES.map((r) => [r.value, r.label] as const)}
            />
            <span className="hint">{ROLES.find((r) => r.value === role)?.says}</span>
          </div>

          {create.error ? <p className="bad">{why(create.error)}</p> : null}
        </div>
      </div>

      <div className="sh-foot">
        <button onClick={onClose} className="btn quiet ml-auto">
          Cancel
        </button>
        <button disabled={!ready || create.isPending} onClick={go} className="btn primary disabled:opacity-50">
          {create.isPending ? "Adding…" : "Add"}
        </button>
      </div>
    </Sheet>
  );
}

export function HandOver({ handed, onClose }: { handed: Handed; onClose: () => void }) {
  /* **The server's own answer, not this tab's address.** The interface and the
     control plane can be two names behind a proxy, so a sign-in link read off
     `window.location` is right only on the installation it happens to be
     served from. Asked for here rather than by the pane, so a member — who
     never reaches this sheet — never asks for it either. */
  const setup = useSetupState();
  const [shown, setShown] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  /* Flashes on the button that was pressed and goes away again, so pressing it
     twice looks like two things rather than one. */
  const [took, setTook] = useState<"password" | "note" | null>(null);

  const hidden = "•".repeat(16);
  const where = setup.data?.publicUrl ?? "";
  /* **The address line is dropped rather than left dangling.** `publicUrl` is
     required on the wire and always arrives from a real server, but the answer
     can still be in flight when this opens — and *Sign in at* with nothing
     after it is a line somebody pastes to a colleague who then cannot find the
     thing. The username and the password are the part that cannot be guessed;
     an address they are about to be told anyway is the part that can wait. */
  const note = (password: string) =>
    `Hi ${handed.username}, you have an account on Firetower.\n\n` +
    (where ? `Sign in at ${where}\n` : "") +
    `Username: ${handed.username}\n` +
    `Password: ${password}  (you will be asked to change it)\n\n` +
    `Once you are signed in there, you can download the Mac or Windows app from the same page.`;

  /* Through `write`, which the rest of the product already uses: it falls back
     to a selection when `navigator.clipboard` is missing or refuses — a
     self-hosted Firetower is often reached over plain http, where the modern
     API is simply `undefined` — and says so when neither works. */
  const put = (what: "password" | "note", text: string, confirm: string) => {
    void write(text).then((ok) => {
      if (ok) {
        setSaid(confirm);
        setTook(what);
        window.setTimeout(() => setTook((now) => (now === what ? null : now)), 1600);
        return;
      }
      /* Nothing reached the clipboard by either route, so the only way this
         password leaves the screen is somebody reading it — and it is still
         masked. Revealing it is the whole of the advice; the sentence alone
         would send them to select a row of dots. */
      setShown(true);
      setSaid("That didn’t copy. It is shown now — select it and copy by hand.");
    });
  };

  return (
    <Sheet
      label={`A password for ${handed.username}`}
      title={handed.fresh ? `${handed.username} is in` : `A new password for ${handed.username}`}
      says="This password is shown once. The server keeps no readable copy."
      onClose={onClose}
    >
      <div className="dbody scroll-slim">
        <div className="form">
          <div className="fld">
            <span>Temporary password</span>
            <div className="flex items-stretch gap-2">
              <span className="box mono min-w-0 flex-1">
                {/* **`select-all` on the password and `select-none` on the
                    mask.** The two used to share one span, so a drag across a
                    masked field quietly yielded sixteen bullets — the shape of
                    a password, on the clipboard, for an account whose real one
                    is never shown again. */}
                {shown ? (
                  <span className="truncate select-all">{handed.password}</span>
                ) : (
                  <span className="truncate select-none" aria-hidden>
                    {hidden}
                  </span>
                )}
              </span>
              {/* The two controls act on the same thing, so they sit together
                  and apart from it. */}
              <span className="flex shrink-0 items-center gap-0.5">
                <IconButton
                  of={shown ? EyeOff : Eye}
                  label={shown ? "Hide it" : "Show it"}
                  onClick={() => setShown((v) => !v)}
                />
                {/* **The button answers, not only the line underneath it.** A
                    tick two lines away from the thing you pressed is read by
                    nobody. */}
                <IconButton
                  of={took === "password" ? Check : Clipboard}
                  label={took === "password" ? "Copied" : "Copy the password"}
                  className={took === "password" ? "text-sage" : ""}
                  onClick={() => put("password", handed.password, "Password copied.")}
                />
              </span>
            </div>
            <span className="hint">
              {said ?? "They are asked to change it the first time they sign in."}
            </span>
          </div>

          <div className="fld">
            <span>Send them this</span>
            <pre className="scroll-slim max-h-44 overflow-y-auto rounded-xl border border-line bg-ground px-3 py-2.5 text-meta leading-relaxed whitespace-pre-wrap text-text">
              {note(hidden)}
            </pre>
            <span className="hint">The password is hidden here and copied in full.</span>
          </div>
        </div>
      </div>

      <div className="sh-foot">
        <button
          onClick={() => put("note", note(handed.password), "Copied, with the password in it.")}
          className="btn plain"
        >
          {took === "note" ? "Copied" : "Copy instructions with password"}
        </button>
        <button onClick={onClose} className="btn primary ml-auto">
          Done
        </button>
      </div>
    </Sheet>
  );
}

/**
 * The sheet both of these are: a head, a scrolling body and a foot.
 *
 * The shape `config/AgentTeams.tsx`'s *New team* already is, written once here
 * because this file needs two of them. Not `.dlg` — that is `Confirm`'s, and it
 * is a question with a yes; these have fields in them and a body that scrolls.
 */
function Sheet({
  label,
  title,
  says,
  onClose,
  children,
}: {
  label: string;
  title: string;
  says: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-scrim pt-[10vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label={label}
        className="flex max-h-[80vh] w-[29rem] flex-col overflow-hidden rounded-xl border border-line lift shadow-(--shadow-float)"
      >
        <div className="flex items-start gap-2 border-b border-line px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-ui text-bone">{title}</span>
            <span className="block text-micro text-mute">{says}</span>
          </span>
          <IconButton of={X} label="Close" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}
