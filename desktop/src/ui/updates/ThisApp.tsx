/**
 * This copy of the app — its build, and its channel.
 *
 * Two release trains share this screen. The app updates itself from its own
 * release and anybody may update their own copy; the deployment above is
 * moved by a run, and mostly by an administrator. Different version numbers,
 * different permissions — so a section of its own rather than a fourth row in
 * a list that would then have to explain which is which.
 *
 * **The channel here is one control, deliberately.** Above it, the
 * installation's channel is a section with a heading, a row per channel, a
 * decision block and a panel behind its one button. This one is a segmented
 * control in a row with a sentence under it, because it is a preference on
 * this machine that affects nobody else and is reversible by construction.
 * Two equal-looking toggles would be the failure the whole screen is built to
 * avoid.
 *
 * Nothing in a browser tab: a tab has no build of its own to move.
 */
import { AlertTriangle, Download, Info, Loader2, Monitor } from "lucide-react";
import { Icon, Review, Segmented } from "~/components/ui";
import { Channel } from "~/api/generated/model";
import type { AppChannel } from "~/channel";
import type { Build } from "~/update";
import type { Span } from "~/releases";
import { aheadOfGeneral } from "~/api/updates";
import { ChangelogSpan } from "./Span";

const CHANNELS = [
  ["general", "General access"],
  ["beta", "Beta"],
] as const;

export function ThisApp({
  build,
  channel,
  onChannel,
  from,
  generalPin,
  installationChannel,
  trouble,
  onTake,
  span,
  spanOpen,
  spanPending,
  onSpan,
  releasePage,
  shown,
}: {
  build: Build;
  /** The channel this copy is set to. */
  channel: AppChannel;
  onChannel: (next: AppChannel) => void;
  /** Which channel the running build came from, when it is known. */
  from: AppChannel | null;
  /** What general access holds for the app, from the installation's manifest. */
  generalPin: string | null;
  /** The installation's channel, when the server can say. */
  installationChannel: Channel | null;
  trouble: string | null;
  onTake: () => void;
  span: Span | null;
  spanOpen: boolean;
  spanPending: boolean;
  onSpan: () => void;
  releasePage: string;
  /**
   * Whether this copy draws the release channels at all — `channelsShown` in
   * `api/updates.ts`. With it off, the one control and the note about joining
   * beta by hand both go, and what is left of this section is a version, a
   * button and what changed.
   */
  shown: boolean;
}) {
  const taking = build.taking;
  /**
   * **Ahead of general access, which is a state and not an error.**
   *
   * It is what switching back actually produces: the copy keeps the beta
   * build it already has — nothing is ever moved backwards — so for a while
   * it is running something general access has not reached. A check finding
   * nothing is the correct answer here, and it ends by itself.
   */
  const ahead = channel === "general" && aheadOfGeneral(build.version, generalPin);

  const sub = ahead
    ? "On general access, running a beta build."
    : channel === "beta"
      ? "On beta. It updates itself from its own release and does not ask the deployment."
      : "Updates itself from GitHub. It does not ask the deployment.";

  return (
    <section className="upd-sec" data-part="B">
      <h2>This app</h2>
      <p className="note">
        Two release trains share this screen. The app updates itself from its own release and anybody
        may update their own copy; the deployment above is moved by a run, and mostly by an
        administrator.
      </p>

      <div className="upd-row">
        <span className="g">
          <Icon of={Monitor} size={20} />
        </span>
        <span className="tx">
          <b>This app</b>
          <s>{sub}</s>
        </span>
        <span className="ver">
          {build.version ?? "—"}
          {from && <i>from {from === "beta" ? "beta" : "general access"}</i>}
        </span>
        <span className="acts">
          {build.newer ? (
            <button disabled={!!taking} onClick={onTake} className="btn primary">
              <Icon
                of={taking ? Loader2 : Download}
                size={14}
                className={taking ? "animate-spin" : undefined}
              />
              {taking
                ? taking.total
                  ? `Downloading… ${Math.min(100, Math.round((taking.downloaded / taking.total) * 100))}%`
                  : "Downloading…"
                : `Update to ${build.newer} and relaunch`}
            </button>
          ) : (
            <span className="text-ui text-dim">Up to date</span>
          )}
        </span>
      </div>

      {/* **One control, one sentence.** The weight is the whole argument: the
          installation's channel above is a section, and this is a row. */}
      {shown && (
      <div className="upd-row">
        <span className="tx">
          <b>Channel for this copy</b>
          <s>
            {channel === "beta"
              ? "This copy only. Switching back stops new betas; it does not reinstall the general-access build."
              : "This copy only, and reversible. Beta takes effect at the next check, without restarting."}
          </s>
        </span>
        <span className="acts">
          <Segmented
            options={CHANNELS}
            value={channel}
            onChange={onChannel}
            label="Channel for this copy"
          />
        </span>
      </div>
      )}

      {trouble && (
        <p className="mt-2 flex items-start gap-2 rounded-lg bg-raise px-3 py-2 text-micro leading-relaxed text-brick">
          <Icon of={AlertTriangle} size={12} />
          <span className="min-w-0 flex-1">{trouble}</span>
        </p>
      )}

      {/* **A supported combination, so nothing warns about it.** The two
          channels are chosen by different people and were made independent on
          purpose. One line states it and stops. */}
      {installationChannel && installationChannel !== channel && (
        <div className="note2">
          <span className="g">
            <Icon of={Info} size={14} />
          </span>
          <p>
            This copy is on {channel === "beta" ? "beta" : "general access"} and this Firetower is on{" "}
            {installationChannel === Channel.beta ? "beta" : "general access"}. That is supported: a
            newer app works against an older control plane, and the two channels are chosen by
            different people.
          </p>
        </div>
      )}

      {ahead && <Ahead version={build.version as string} generalPin={generalPin as string} />}

      {build.newer && (
        <>
          <div className="note2">
            <span className="g">
              <Icon of={Download} size={14} />
            </span>
            <p>
              <button type="button" onClick={onSpan} aria-expanded={spanOpen} className="linkish">
                {spanOpen ? "Hide what changed" : "What changed in this update"}
              </button>
            </p>
          </div>
          {spanOpen && <ChangelogSpan span={span} pending={spanPending} />}
        </>
      )}

      {/* How somebody on a copy too old to carry the beta address joins it at
          all. It is the answer to a question that is only asked once the
          channels are on the page. */}
      {shown && (
        <div className="note2">
          <span className="g">
            <Icon of={Download} size={14} />
          </span>
          <p>
            Joining beta on a copy older than this one takes one download from its release page. Every
            copy carries its update address inside the bundle, so installing by hand once is the only
            way to a different one. After that it updates on beta by itself.{" "}
            <a className="linkish" href={releasePage} target="_blank" rel="noreferrer">
              The release page
            </a>
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Ahead of general access — a named state, with what would end it.
 *
 * **Not an error, and not drawn as one.** Slate, because it states a fact
 * nobody has to act on. The refusal it comes from is about the *version* and
 * never about the channel: a copy is never moved to an older build, so
 * leaving beta leaves this copy where it is until general access catches up.
 */
function Ahead({ version, generalPin }: { version: string; generalPin: string }) {
  return (
    <Review
      tone="slate"
      mark={<Icon of={Info} size={16} />}
      title="Ahead of general access"
      acts={
        <span className="risk">
          <i />
          Going back to beta would offer the next beta release at the next check.
        </span>
      }
    >
      <p>
        This copy is on general access and running {version}, which came from beta. General access is
        at {generalPin}, and a copy is never moved back to an older build.
      </p>
      <div className="plan-files">
        <div className="diffrow">
          <span className="k">this copy</span>
          <span className="p">{version}</span>
          <span className="n">installed from beta</span>
        </div>
        <div className="diffrow">
          <span className="k">offering</span>
          <span className="p">{generalPin}</span>
          <span className="n">general access</span>
        </div>
      </div>
      <p className="mt-3">
        Updates start again when general access reaches {version} or later. There is no date for that:
        beta runs ahead by as much as it runs ahead. Nothing is wrong with this copy in the meantime,
        and a check finding nothing is the right answer.
      </p>
    </Review>
  );
}
