/**
 * Two codes, two links, and which Firetower to point the phone at.
 *
 * Opened from the profile menu's *Get the mobile app* row. A code on a desk
 * screen is scanned by the phone that is about to install the thing, which is
 * the one case where a code is the right control rather than decoration — so
 * it has to actually scan, from across a desk, in both themes, on an Android
 * camera as well as an iPhone one. `QrCode.tsx` and `.qr` carry that; this
 * file carries the room around it.
 *
 * ## A dialog, and not a second page of the menu
 *
 * Three reasons, in order of weight.
 *
 * **The two codes need 396px side by side** and `Pop` holds 252, widening to
 * 296 for the switcher. The commonest case — Android — would go behind a tab.
 *
 * **The menu's second page is the one thing a browser does not have.**
 * `installedApp()` is what makes `page === "switch"` unreachable there, and
 * putting an *ungated* thing inside that mechanism is the wrong shape: it
 * would make `page` a three-value state in one client and a two-value state in
 * the other, for a row that is identical in both.
 *
 * **`Pop` closes on any ancestor scroll and on resize.** A `role="menu"`
 * carrying a payload you stand in front of for fifteen seconds is a menu doing
 * something a menu does not do.
 *
 * So it borrows `Confirm.tsx`'s `.dlg` and its three dismissals — Escape, a
 * `mousedown` on the scrim, and the button — and deliberately does **not**
 * become a `useConfirm`. This is not a question with an answer.
 *
 * ## The wrapper scrolls, which `Confirm`'s does not
 *
 * Measured, not reasoned about: this dialog is 444 × 566 and
 * `tauri.conf.json`'s `minHeight` is 560. Copying `Confirm`'s wrapper verbatim
 * puts *Done* 55px below the fold of a minimum window with no way to reach it.
 * Both codes, both captions and both links are above the fold at 560; the
 * address block starts 2px below it. The fix belongs here rather than to
 * `Confirm`, whose own dialogs are four lines tall and do not have the
 * problem.
 *
 * ## No third code, for this Firetower's address
 *
 * A decision rather than an omission. `mobile/app/connect.tsx` takes the
 * address in a field and says why — "One field takes the address. **Not a
 * code.**" The phone app has no scanner and `app.config.ts`'s `firetower`
 * scheme has no handler, so a code encoding the origin would be read by the
 * phone's camera app and opened in Safari: the renderer in a mobile browser,
 * which is not the app. The address stays a line of text with a copy button.
 *
 * ## Mobile only
 *
 * `web/components/GetTheApp.tsx` carries a desktop half too — `generalPin` and
 * its six channel-manifest outcomes, three platform tiles, `BetaRoute`, Linux.
 * That half is **not** here and is not dying with the native shell; it is
 * dying with `web/`, and it still has no home. It is a screen, not a menu row:
 * a different audience, a different trigger, and a body of correctness that
 * was argued over twice. A row saying *Get the mobile app* cannot honestly
 * hold a Windows installer.
 */
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "~/components/ui";
import { QrCode } from "~/components/ui/QrCode";
import {
  androidFace,
  apkIn,
  apkShown,
  boxFor,
  dialogWidth,
  FEED,
  RELEASES,
  TESTFLIGHT,
  TESTFLIGHT_SHOWN,
  type Found,
} from "~/ui/mobile-app";

/** The dialog, with its own one-shot read of the releases feed. */
export function GetTheMobileApp({ address, onClose }: { address: string; onClose: () => void }) {
  const found = useApk();
  return <MobileApp address={address} found={found} onClose={onClose} />;
}

/**
 * The one lookup, made once when the dialog opens.
 *
 * A refusal is a failed lookup and **not** an empty release list: the common
 * one is this unauthenticated request meeting the sixty-an-hour rate limit,
 * shared by everybody behind one address, and answering that with `[]` would
 * say *no release carries an APK yet* — a different and untrue thing. The
 * other two real causes are a self-hosted Firetower with no outbound route at
 * all, and DNS.
 */
function useApk(): Found {
  const [found, setFound] = useState<Found>({ at: "looking" });

  useEffect(() => {
    let live = true;
    fetch(FEED, { headers: { accept: "application/vnd.github+json" } })
      .then((answer) => {
        if (!answer.ok) throw new Error(`GitHub answered ${answer.status}`);
        return answer.json();
      })
      .then((body: unknown) => {
        if (!live) return;
        const apk = apkIn(body);
        setFound(apk ? { at: "ready", apk } : { at: "none" });
      })
      .catch(() => {
        if (live) setFound({ at: "unreachable" });
      });
    return () => {
      live = false;
    };
  }, []);

  return found;
}

/**
 * The dialog itself, as a function of what is known.
 *
 * Separate from the read above for the same reason `Confirm` separates
 * `Dialog` from its provider: every state this draws is then a value in and
 * markup out, so the three that are only reachable through a network call can
 * be drawn and asserted without stalling or breaking a `fetch`.
 */
export function MobileApp({
  address,
  found,
  onClose,
}: {
  /** `backend.url`, which is the one line that differs between the clients:
   *  in a browser `probe.ts` has already resolved it to the origin the page
   *  came from, and in the installed app it is the Firetower this window is on
   *  and it changes when you switch. Reading it rather than
   *  `window.location.origin` is what makes one line correct in both. */
  address: string;
  found: Found;
  onClose: () => void;
}) {
  const done = useRef<HTMLButtonElement>(null);
  const android = androidFace(found);
  const apk = found.at === "ready" ? found.apk : null;

  /* The box both codes are drawn at, and the width that falls out of it.
     Never written down: see `mobile-app.ts`. */
  const box = boxFor([TESTFLIGHT, apk?.url]);
  const width = dialogWidth(box);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    done.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    /* `overflow-y-auto` is the one thing this wrapper has that `Confirm`'s
       does not, and the reason is at the top of this file. */
    <div
      data-testid="mobile-app-scrim"
      onMouseDown={onClose}
      className="fixed inset-0 z-[60] grid place-items-start justify-center overflow-y-auto bg-scrim px-4 pt-[12vh] pb-8 backdrop-blur-[2px]"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-labelledby="mobile-app-title"
        data-testid="mobile-app-dialog"
        className="dlg codes"
        style={{ width }}
      >
        <h2 id="mobile-app-title" data-testid="mobile-app-title">
          Get the mobile app
        </h2>
        {/* Load-bearing rather than throat-clearing: it is the only thing on
            screen that explains the absence of an App Store badge, which is
            otherwise the first thing a reader looks for and the first thing
            they conclude is broken. */}
        <p className="say" data-testid="mobile-app-lede">
          Scan a code with the phone you want it on. Both are betas, and neither is on a store yet.
        </p>

        <div className="pair" data-testid="mobile-app-pair">
          {/* iPhone. Apple's public beta link does not move, so this column
              is a constant: it never waits and it never fails. */}
          <div className="col" data-testid="mobile-app-iphone">
            <QrCode
              value={TESTFLIGHT}
              width={box}
              label={`iPhone, through TestFlight: ${TESTFLIGHT}`}
              testid="mobile-app-iphone-code"
            />
            <div className="cap">
              <div className="nm" data-testid="mobile-app-iphone-name">
                iPhone
              </div>
              <div className="ln" data-testid="mobile-app-iphone-line">
                Through TestFlight
              </div>
            </div>
            {/* The link beside the code, because the screen may itself be the
                phone — the renderer is served at the control plane's root, and
                nobody can scan the screen they are holding. */}
            <Well
              testid="mobile-app-iphone-link"
              valueId="mobile-app-iphone-url"
              copyId="mobile-app-iphone-copy"
              shown={TESTFLIGHT_SHOWN}
              copy={TESTFLIGHT}
              label="Copy the TestFlight link"
            />
          </div>

          {/* Android. The one that is looked up, and so the one with states. */}
          <div className="col" data-testid="mobile-app-android">
            {apk ? (
              <QrCode
                value={apk.url}
                width={box}
                label={`Android, an APK: ${apk.url}`}
                testid="mobile-app-android-code"
              />
            ) : (
              <div
                className="qrwait"
                role="status"
                data-testid="mobile-app-android-waiting"
                style={{ width: box, height: box }}
              >
                {android.wait}
              </div>
            )}
            <div className="cap">
              <div className="nm" data-testid="mobile-app-android-name">
                Android
              </div>
              <div className="ln" data-testid="mobile-app-android-line">
                {android.line}
              </div>
            </div>
            {android.chip === "none" ? (
              <div className="why" data-testid="mobile-app-android-why">
                {android.why}
              </div>
            ) : (
              <Well
                testid="mobile-app-android-link"
                valueId="mobile-app-android-url"
                copyId="mobile-app-android-copy"
                shown={apk ? apkShown(apk.url) : "—"}
                copy={apk?.url}
                label="Copy the APK link"
              />
            )}
          </div>
        </div>

        <div className="rule" />

        {/* The job is not done when the app is installed but when it is
            pointed at this Firetower, and typing an origin on a phone keyboard
            is the painful part. A short sentence rather than a label, because
            `.eyebrow` is retired on the desk. */}
        <div className="addr" data-testid="mobile-app-address">
          <div className="ln" data-testid="mobile-app-address-line">
            The app asks which Firetower to connect to. This one is:
          </div>
          <Well
            testid="mobile-app-address-chip"
            valueId="mobile-app-address-value"
            copyId="mobile-app-address-copy"
            shown={address}
            copy={address}
            label="Copy the address"
          />
        </div>

        <div className="foot">
          {/* The remedy for every state this dialog cannot observe: a
              TestFlight group that has hit Apple's ten-thousand ceiling, a
              build past its ninety days, an APK that was taken down. None of
              them is readable from here, and all of them end at this link. */}
          <span className="where" data-testid="mobile-app-releases">
            Every release is on{" "}
            <a href={RELEASES} target="_blank" rel="noreferrer">
              GitHub
            </a>
            .
          </span>
          <button ref={done} onClick={onClose} data-testid="mobile-app-done" className="btn plain">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A line of machine text with a way to take it.
 *
 * `-chip` on the address and `-link` on the two URLs, which is the contract's
 * distinction and a real one: an address is a value you take, and the other
 * two are links you could also follow.
 *
 * **Named after its class rather than after the contract's word for it.** The
 * contract calls this a chip and lists `.chip` as a new class; `styles.css`
 * has had one since the composer, worn eleven times, and a second block under
 * that name would have won on source order and restyled every one of them.
 * The ids keep the contract's word — they are what QA checks by name — and
 * the class and this component take the one the stylesheet had free.
 *
 * Without `copy` it is holding its place rather than offering anything — the
 * lookup is still out, and a column that gains a button when the answer lands
 * is a column that moves under the reader.
 */
function Well({
  testid,
  valueId,
  copyId,
  shown,
  copy,
  label,
}: {
  testid: string;
  valueId: string;
  copyId: string;
  shown: string;
  copy?: string;
  label: string;
}) {
  return (
    <div className="well" data-testid={testid} data-dead={copy ? undefined : "1"}>
      <span className="tx" data-testid={valueId} title={copy}>
        {shown}
      </span>
      {copy && <CopyButton text={copy} label={label} testid={copyId} />}
    </div>
  );
}
