/**
 * The channel of **this Firetower** — the installation's, not this copy's.
 *
 * Two channel controls now sit a few rows apart on one screen and they mean
 * different things. This one is install-wide, derived from the tag on the
 * running image, an administrator's, and it moves the whole deployment. The
 * other is a preference on this machine that affects nobody else.
 *
 * **They are kept apart by weight, not by colour.** A channel is not a hue —
 * ember answers one question and colour is fully spent elsewhere — so this is
 * a section with a heading, a note, a row per channel, a decision block when
 * there is something in the way, and a panel behind the one button. The
 * per-copy control is one segmented control with a sentence under it. Two
 * equal-looking toggles would be the failure.
 *
 * **Nothing here decides what may be done.** The server publishes an action
 * per channel row or the reason there is none, and a refusal comes back
 * carrying the sentence the server already published — so the screen never
 * offers a control the server would refuse, and never writes its own words
 * over the server's.
 */
import { useState } from "react";
import { AlertTriangle, Check, Info, Play, Save, Tag, X } from "lucide-react";
import { FileDiff, Icon, Review } from "~/components/ui";
import type { ChannelStatus, FileChoice, FilePlan, Offer, UpgradePlan } from "~/api/generated/model";
import { Act, Channel } from "~/api/generated/model";
import type { ChannelBlock, ManifestTrouble } from "~/api/updates";
import { channelBlock, manifestTrouble, needsChoice, pinOffer, rowOffers, rowVerdict } from "~/api/updates";

/** What the screen asks to have done, once somebody presses. */
export type ChannelAct = { channel: Channel; act: Act };

export function ChannelSection({
  channel,
  blocked,
  shown,
  onAct,
}: {
  channel: ChannelStatus;
  /** A run is going, so nothing may be started. */
  blocked: boolean;
  /**
   * Whether this copy draws the channels at all — `channelsShown` in
   * `api/updates.ts`. With it off the section stops being a chooser and
   * becomes a statement of what this Firetower runs.
   */
  shown: boolean;
  onAct: (act: ChannelAct) => void;
}) {
  const may = (channel.mayChange ?? false) && !blocked;
  const block = channelBlock(channel);
  const pin = pinOffer(channel);
  /* A second axis, and a second block. The one above is about this
     installation's image line; this is about the document every installation
     reads, so they can both be true at once and neither stands in for the
     other. */
  const manifest = manifestTrouble(channel.manifest);

  return (
    <>
      {/* **The decision blocks are drawn either way, and that is deliberate.**
          They are not about beta: they are what an installation is told when
          its image line names no channel, or names an exact version, or there
          is no updater to ask — and each one is in the way of every upgrade
          until somebody fixes it. Hiding them with the channels would leave an
          installation frozen with nothing on the screen saying why. One of
          them has to name `:beta` to do its job, because it is one of the two
          tags the line may be changed to; there, the name is the instruction.
          See `Tags`. */}
      {block && <Trouble channel={channel} block={block} pin={may ? pin : undefined} onAct={onAct} />}
      {manifest && <Manifest trouble={manifest} url={channel.manifest.url} />}
      <section className="upd-sec">
        <h2>{shown ? "Channel for this Firetower" : "Releases for this Firetower"}</h2>
        <p className="note">
          {shown ? (
            <>
              Which releases this deployment is offered, for everybody connected to it. The channel is
              the image tag in <code className="font-mono">firetower.yml</code>, read back from the
              container that is running. Nothing else records it.
            </>
          ) : (
            <>
              This Firetower runs the releases a maintainer has promoted, for everybody connected to
              it. Which one it is on is the image tag in{" "}
              <code className="font-mono">firetower.yml</code>, read back from the container that is
              running. Nothing else records it.
            </>
          )}
        </p>
        {/* A row per channel is a comparison, and a comparison of one is a
            list that asks what the other one was. So with the channels hidden
            there are no rows: the paragraph above is the whole answer. */}
        {shown && (
          <div className="mt-3">
            {channel.offers.map((offer) => (
              <ChannelRow
                key={offer.channel}
                offer={offer}
                channel={channel}
                mayChange={channel.mayChange ?? false}
                blocked={blocked}
                onAct={onAct}
              />
            ))}
          </div>
        )}
        <After channel={channel} saidAlready={!!manifest} shown={shown} />
      </section>
    </>
  );
}

/**
 * One channel, and what it offers.
 *
 * `.mach`'s geometry with a mark cell instead of a checkbox: a channel is not
 * a thing you tick, and the row itself is not a button — pressing a row that
 * changed a whole deployment's channel is not a press anybody meant.
 */
function ChannelRow({
  offer,
  channel,
  mayChange,
  blocked,
  onAct,
}: {
  offer: Offer;
  channel: ChannelStatus;
  mayChange: boolean;
  blocked: boolean;
  onAct: (act: ChannelAct) => void;
}) {
  const verdict = rowVerdict(offer, channel, mayChange, blocked);
  const on = offer.on && channel.recognised;
  return (
    <div className="chan" data-on={on} data-off={!on}>
      <span className="mk">{on && <Check className="h-4 w-4" strokeWidth={2} />}</span>
      <span className="tx">
        <b>{offer.channel === Channel.beta ? "Beta" : "General access"}</b>
        <s>{rowOffers(offer)}</s>
      </span>
      {verdict.kind === "act" ? (
        <span className="acts">
          <button
            onClick={() => onAct({ channel: offer.channel, act: verdict.act })}
            className="btn plain"
          >
            Switch to {offer.channel === Channel.beta ? "beta" : "general access"}…
          </button>
        </span>
      ) : (
        <span className="verdict">{verdict.kind === "on" ? "On this installation" : verdict.said}</span>
      )}
    </div>
  );
}

/**
 * The one line under the rows, which is a different line for each reader.
 *
 * A member gets the one that answers "why does my colleague have this" — the
 * question a channel creates, on the only screen that can answer it.
 */
function After({
  channel,
  saidAlready,
  shown,
}: {
  channel: ChannelStatus;
  saidAlready: boolean;
  shown: boolean;
}) {
  const may = channel.mayChange ?? false;
  const onBeta = channel.channel === Channel.beta && channel.recognised;

  /* **The member's line comes first, whichever channel is in force.** For
     somebody who cannot change it, the question the channel creates is "why
     does my colleague have this" — and the answer is whose it is and where
     their own copy's channel is. What leaving beta would cost is an
     administrator's problem, and they are not one.

     With the channels hidden there is no channel to explain and no copy's
     channel to point at, so the same line answers the question that is left:
     who moves this Firetower, and what moving it costs everybody else. */
  if (!may) {
    return (
      <div className="note2">
        <span className="g">
          <Icon of={Info} size={14} />
        </span>
        <p>
          {shown
            ? "The channel is the same for everybody connected to this Firetower, and changing it is an administrator's. Your own copy of the app has its own channel, below."
            : "Upgrading this Firetower is an administrator's, and it moves it for everybody connected to it. Your own copy of the app updates itself, below."}
        </p>
      </div>
    );
  }
  /* **The corrected position, and it matters which half is said where.** The
     refusal is about the *version*, never about membership of a channel:
     switching back is refused while it would be a downgrade, and allowed the
     moment it would not be. "You cannot leave beta" would simply be false. */
  if (onBeta) {
    return (
      <div className="note2">
        <span className="g">
          <Icon of={Info} size={14} />
        </span>
        <p>
          Beta installs every release as it is cut, so this installation usually runs ahead of general
          access. Leaving is refused only while it would move this installation to an older version —
          nothing is ever moved backwards, and migrations do not run backwards. Once general access
          reaches the version this installation is on, going back is an ordinary switch.
        </p>
      </div>
    );
  }
  /* Why a switch could not be carried out at all — the server's sentence,
     under the rows where a paragraph fits rather than inside one. Only to
     somebody who could act on it. */
  if (!channel.switchable && channel.reason && !saidAlready) {
    return (
      <div className="note2">
        <span className="g">
          <Icon of={AlertTriangle} size={14} />
        </span>
        <p>{channel.reason}</p>
      </div>
    );
  }
  return null;
}

/* ── The block that carries a decision ─────────────────────────────────── */

/** What each block says, and what it offers to do about it. */
function Trouble({
  channel,
  block,
  pin,
  onAct,
}: {
  channel: ChannelStatus;
  block: ChannelBlock;
  /** The pin, when this reader may take it. */
  pin?: Offer;
  onAct: (act: ChannelAct) => void;
}) {
  const general = channel.offers.find((o) => o.channel === Channel.general);
  const beta = channel.offers.find((o) => o.channel === Channel.beta);
  const act = pin && <PinButton pin={pin} onAct={onAct} />;

  if (block.kind === "noUpdater") {
    return (
      <Review tone="slate" mark={<Icon of={AlertTriangle} size={16} />} title="No updater beside this control plane">
        <p>{channel.problem}</p>
        <p className="mt-3">
          One <span className="font-mono text-text">firetower upgrade</span> on the machine adds it. If
          the container is already there, add{" "}
          <span className="font-mono text-text">FIRETOWER_UPDATER_TOKEN</span> to{" "}
          <code>.env</code> — the updater refuses everything without it.
        </p>
        <div className="acts">
          <span className="risk">
            <i />
            Machines are moved over ssh and are not affected.
          </span>
        </div>
      </Review>
    );
  }

  if (block.kind === "pinned") {
    return (
      <Review tone="amber" mark={<Icon of={AlertTriangle} size={16} />} title="Pinned to an exact version">
        <p>{channel.reason ?? channel.problem}</p>
        <Tags channel={channel} general={general} beta={beta} />
        <p className="mt-3">
          Until that line names a channel this installation cannot be upgraded from here at all — the
          updater refuses to move a container pinned to a version. It is one line, on the machine.
        </p>
      </Review>
    );
  }

  /* The pre-channel floating tag, which is the one that actively hands this
     installation the wrong build. It follows the newest build published,
     which under a continuous beta is beta's — so the updater fetches a
     version it was not told to fetch and stops. The message it gets today
     blames a release race; this names the real cause. */
  if (block.kind === "frozen") {
    return (
      <Review
        tone="amber"
        mark={<Icon of={AlertTriangle} size={16} />}
        title="Pinned to a tag that is not a channel"
        acts={act && <>{act}<span className="risk"><i />Pinning <span className="font-mono">:{beta?.tag}</span> instead takes every release as it is cut.</span></>}
      >
        <p>
          <code>firetower.yml</code> pins{" "}
          <span className="font-mono text-text">{channel.image ?? `:${channel.tag}`}</span>. That tag
          follows the newest build published, which is beta's — so an upgrade fetches a version it was
          not told to fetch and refuses to go on. This Firetower cannot upgrade until the line changes.
        </p>
        <Tags channel={channel} general={general} beta={beta} />
        <p className="mt-3">
          Pinning <span className="font-mono text-text">:{general?.tag}</span> leaves this installation
          where it is and lets it move again. It is one line, and the updater writes it the same way it
          writes any deployment file.
        </p>
      </Review>
    );
  }

  return (
    <Review
      tone="slate"
      mark={<Icon of={Tag} size={16} />}
      title="This tag does not name a channel"
      acts={act}
    >
      <p>{channel.problem}</p>
      <p className="mt-3">
        An upgrade from here will refuse for the same reason a floating pin does: the version that
        arrives is not the version it was told to fetch. Naming a channel in <code>firetower.yml</code>{" "}
        is what clears it.
      </p>
      <Tags channel={channel} general={general} beta={beta} />
    </Review>
  );
}

/**
 * The channel manifest, when it is in trouble.
 *
 * **Two states, and the whole value of drawing them apart is that they do not
 * read alike.** A read that failed is transient and the answer is to wait. A
 * document that was read before and is gone has been *destroyed* — and until
 * somebody republishes it every installation reading it is told the same
 * thing, so waiting is the one thing that does not help. Amber against slate,
 * a different heading, and a different next action.
 *
 * The sentence itself is the server's: it is the one it published, and it
 * says which of the two this is in words as well as in weight.
 */
function Manifest({ trouble, url }: { trouble: ManifestTrouble; url: string }) {
  if (trouble.kind === "destroyed") {
    return (
      <Review
        tone="amber"
        mark={<Icon of={AlertTriangle} size={16} />}
        title="The channel manifest has been destroyed"
        acts={
          <span className="risk">
            <i />
            Nothing is being moved in the meantime, which is the safe answer.
          </span>
        }
      >
        <p>{trouble.problem}</p>
        <p className="mt-3">
          It is the one document that says which version each channel holds, so every installation
          reading it is told this until it is back. <b>Waiting does not fix it</b> — it has to be
          published again, at{" "}
          {/* An address is prose here, not code: it may break anywhere rather
              than push the column sideways at the narrow end. */}
          <span className="font-mono break-all text-text">{url}</span>.
        </p>
      </Review>
    );
  }
  return (
    <Review
      tone="slate"
      mark={<Icon of={Info} size={16} />}
      title="The channel manifest could not be read this time"
      acts={
        <span className="risk">
          <i />
          The versions above are from the last document that did read.
        </span>
      }
    >
      <p>{trouble.problem}</p>
      <p className="mt-3">
        Nothing is being moved, which is the answer to a read that went wrong rather than to a
        document that said something. This usually clears by itself; the next check asks again.
      </p>
    </Review>
  );
}

function PinButton({ pin, onAct }: { pin: Offer; onAct: (act: ChannelAct) => void }) {
  return (
    <button onClick={() => onAct({ channel: pin.channel, act: Act.pin })} className="btn primary">
      Pin :{pin.tag}
      {pin.version ? ` and upgrade to ${pin.version}` : ""}
    </button>
  );
}

/** The tags, and what each one would mean here. The tag to use, named. */
function Tags({
  channel,
  general,
  beta,
}: {
  channel: ChannelStatus;
  general?: Offer;
  beta?: Offer;
}) {
  return (
    <div className="plan-files">
      <div className="diffrow">
        <span className="k">pinned</span>
        <span className="p">:{channel.tag}</span>
        <span className="n">{channel.pinned ? "an exact version — nothing can move it" : "not a channel"}</span>
      </div>
      {general && (
        <div className="diffrow">
          <span className="k">wanted</span>
          <span className="p">:{general.tag}</span>
          <span className="n">{general.version ? `${general.version}, general access` : "general access"}</span>
        </div>
      )}
      {beta && (
        <div className="diffrow">
          <span className="k">or</span>
          <span className="p">:{beta.tag}</span>
          <span className="n">{beta.version ? `${beta.version}, every release` : "every release"}</span>
        </div>
      )}
    </div>
  );
}

/* ── The switch, before it is taken ────────────────────────────────────── */

/**
 * What the switch would write, and what it would move this installation onto.
 *
 * **A panel on the page, not a dialog over it** — the same decision the plan
 * made, for the same reason. The consequence comes before the control, the
 * backup is offered where the decision is made, and the lines that change are
 * shown as a deployment-file diff. Nothing is written until the button at the
 * bottom is pressed, which is where the reading ends.
 */
export function SwitchPanel({
  plan,
  pending,
  trouble,
  lastBackup,
  backingUp,
  backedUp,
  onBackUp,
  onGo,
  onClose,
  starting,
}: {
  plan: UpgradePlan | undefined;
  pending: boolean;
  trouble: string | null;
  /** When the deployment was last backed up, in words. */
  lastBackup: string | null;
  backingUp: boolean;
  backedUp: boolean;
  onBackUp: () => void;
  onGo: (files: FileChoice[]) => void;
  onClose: () => void;
  starting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [replace, setReplace] = useState<Record<string, boolean>>({});
  const change = plan?.channelChange ?? null;
  const files = (plan?.files ?? []) as FilePlan[];
  const kept = (f: FilePlan) => !(replace[f.name] ?? false);
  const choosing = files.filter(needsChoice);
  const pinning = change?.act === Act.pin;
  const to = change
    ? pinning
      ? `general access`
      : change.channel === Channel.beta
        ? "beta"
        : "general access"
    : "";

  return (
    <div className="run">
      <div className="top">
        <b>
          {change
            ? pinning
              ? `Pin :${change.tag} on this Firetower`
              : `Switch this Firetower to ${to}`
            : "Switching this Firetower"}
        </b>
        <button onClick={onClose} className="btn quiet">
          <Icon of={X} size={14} />
          Close
        </button>
      </div>

      {pending && <p className="why">Working out what this would write…</p>}
      {trouble && <p className="why text-brick">{trouble}</p>}

      {change && (
        <>
          {/* **The consequence, before the control.** The correction the
              specification's own wording needed: moving to beta is not
              permanently one-way. What is refused is a *downgrade*. */}
          {change.irreversible && (
            <Review
              tone="amber"
              mark={<Icon of={AlertTriangle} size={16} />}
              title="Beta runs ahead, and leaving waits for general access"
              acts={
                <>
                  <button disabled={backingUp || backedUp} onClick={onBackUp} className="btn plain">
                    <Icon of={Save} size={14} />
                    {backingUp ? "Backing up…" : backedUp ? "Backed up" : "Back up now"}
                  </button>
                  <span className="risk">
                    <i />
                    {backedUp
                      ? "Backed up just now, before the switch."
                      : lastBackup
                        ? `Last backup ${lastBackup}.`
                        : "It takes a few seconds and it is the thing to press before anything else."}
                  </span>
                </>
              }
            >
              <p>
                Beta installs every release as soon as it is cut, so this installation will usually run
                ahead of general access. Switching back is refused while it would move this installation
                to an <b>older version</b> — migrations do not run backwards, and nothing is ever moved
                backwards. It is not refused because of the channel: once general access reaches the
                version this installation is on, leaving beta is an ordinary switch.
              </p>
              <p className="mt-3">
                Back up first all the same. This rewrites a deployment file and upgrades the control
                plane in the same act, and a backup is the thing to press before anything else.
              </p>
            </Review>
          )}

          <p className="why mt-4">
            {change.lines.length === 1 ? "One line" : `${change.lines.length} lines`} in{" "}
            <code>{change.file}</code> move to{" "}
            <span className="font-mono text-text">:{change.tag}</span>, through the updater, and the
            upgrade to {change.version} follows it. The control plane and the updater move together:
            they are built together and their API versions are checked on every call.
          </p>

          <div className="plan-files">
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="diffrow w-full text-left"
            >
              <span className="k">write</span>
              <span className="p">{change.file}</span>
              <span className="n">
                {open
                  ? "hide the diff"
                  : `${change.lines.length} line${change.lines.length === 1 ? "" : "s"}, ${change.lines.length === 1 ? "the image tag" : "both image tags"}`}
              </span>
            </button>
            {open && <FileDiff unified={change.diff} />}
          </div>

          {files.length > 0 && (
            <div className="plan-files">
              {files.map((f) => (
                <div key={f.name} className="diffrow">
                  <span className="k">
                    {f.verdict === "New" ? "new" : needsChoice(f) ? (kept(f) ? "skip" : "write") : "write"}
                  </span>
                  <span className="p">{f.name}</span>
                  {needsChoice(f) && <span className="n inway">your edits are in the way</span>}
                </div>
              ))}
            </div>
          )}

          {plan && plan.envMissing.length > 0 && (
            <p className="why flex items-start gap-2 text-text">
              <Icon of={AlertTriangle} size={14} />
              This version wants {plan.envMissing.join(", ")} set in the environment.
            </p>
          )}

          <div className="note2">
            <span className="g">
              <Icon of={Info} size={14} />
            </span>
            <p>
              The file you have now is kept as <span className="q">{change.file}.backup</span>. If the
              new control plane does not answer <span className="q">/readyz</span>, the previous image
              and the previous file are both put back.
            </p>
          </div>
        </>
      )}

      <div className="foot">
        <button
          disabled={!change || starting}
          onClick={() => onGo(files.map((f) => ({ name: f.name, replace: replace[f.name] ?? !needsChoice(f) })))}
          className="btn primary"
        >
          <Icon of={Play} size={14} />
          {starting
            ? "Starting…"
            : change
              ? pinning
                ? `Pin :${change.tag} and upgrade to ${change.version}`
                : `Switch to ${to} and upgrade to ${change.version}`
              : "Switch"}
        </button>
        {choosing.length > 0 && (
          <button
            onClick={() => setReplace(Object.fromEntries(choosing.map((f) => [f.name, kept(f)])))}
            className="btn plain"
          >
            {choosing.every(kept)
              ? `Take theirs and overwrite ${choosing.length === 1 ? "that file" : "those files"}`
              : `Keep my version of ${choosing.length === 1 ? "that file" : "those files"}`}
          </button>
        )}
        <button onClick={onClose} className="btn quiet">
          Cancel
        </button>
        <span className="text-ui text-dim">Nothing is written until you press it.</span>
      </div>
    </div>
  );
}
