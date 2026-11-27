/**
 * A link, for the phone that is already in your hand.
 *
 * Installing the phone app from a desk screen is the one flow where the
 * address cannot be pasted: the link is on this screen and the device that
 * needs it is a different device. A code closes that gap in the only way that
 * does not involve typing a GitHub release URL into a phone keyboard.
 *
 * Drawn as a path rather than fetched as an image. A self-hosted Firetower is
 * often on a private network with no route to the internet, and a code served
 * from somebody else's chart API would be a broken image exactly there — in
 * the one dialog whose whole job is handing out the app. It also means the
 * code is vector: it stays crisp when the window is zoomed.
 *
 * ## Copied from `web/`, with two changes
 *
 * This is `web/components/ui/QrCode.tsx` with the two things the mobile-app
 * contract asks for. The desk resolves nothing out of `../web` in practice —
 * there is not one such import under `desktop/src` — so a copy is what porting
 * means here, and `web/` keeps its own for as long as `/index` is served.
 *
 * **The two colours moved to CSS, because the web copy inverts in light.**
 * It fills the plate with `--color-bone` and the modules with
 * `--color-ground`, which are the right way round in dark and reversed in
 * light: bone is `#161617` there and ground is `#f2f2f3`, so the code comes
 * out near-white modules on a near-black plate. Inverted codes are outside
 * ISO/IEC 18004 — an iPhone decodes one anyway, a good many Android scanners
 * do not. The pair is now bound in `.qr` to whichever two tokens are light and
 * dark *in each theme*, rather than to one token whose role flips. See
 * `styles.css`; this file deliberately names no colour at all.
 *
 * **The size is derived rather than passed.** A code has a floor below which a
 * camera across a desk stops resolving it, and that floor is per *module*, not
 * per code — so a longer URL needs a bigger box rather than finer modules.
 * `codeWidth` is that arithmetic, exported, so a caller can size the space
 * around a code from the same number the code is drawn at.
 */
import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * The light border around the code, in modules. The spec asks for four; three
 * scans just as well at this size and keeps the modules bigger for the same
 * width on screen, which matters more to a camera than the fourth ring does.
 *
 * It is also the plate's corner radius, which was checked rather than assumed:
 * the arc through (0,3) and (3,0) passes at distance 3 from the corner and the
 * nearest point of a finder's outer ring is at 0.71, so about 2.3 modules of
 * quiet remain diagonally. No encroachment.
 */
const QUIET = 3;

/**
 * The smallest a module may be drawn, in CSS px.
 *
 * At 4px a module is 0.92mm on a 110ppi monitor and 8 device pixels on a 2×
 * display — both comfortably past what a phone camera at arm's length
 * resolves. **Per module, which is the point**: the APK URL encodes to 41
 * modules and TestFlight's to 29, so one fixed box would give them different
 * module sizes and the longer URL would be the one that stopped scanning.
 */
export const FLOOR = 4;

/**
 * How many modules across a code of a given QR version is — the standard's own
 * formula, `17 + 4v`.
 *
 * Here so that a width can be planned for a payload that has not arrived yet
 * without writing the module count down. Version 6 is 41; version 7 is 45.
 */
export const spanOfVersion = (version: number) => 17 + 4 * version;

/** How round a module is, as a fraction of one. Enough to soften the grid;
 *  not so much that neighbours stop reading as joined. */
const R = 0.34;

/** A rounded module, relative to its top-left — so only the `M` differs. */
const MODULE = [
  `h${1 - 2 * R}`,
  `a${R} ${R} 0 0 1 ${R} ${R}`,
  `v${1 - 2 * R}`,
  `a${R} ${R} 0 0 1 -${R} ${R}`,
  `h-${1 - 2 * R}`,
  `a${R} ${R} 0 0 1 -${R} -${R}`,
  `v-${1 - 2 * R}`,
  `a${R} ${R} 0 0 1 ${R} -${R}`,
  "z",
].join("");

/**
 * How wide a code of `modules` across has to be drawn for one module to clear
 * `module` CSS px. The quiet zone is part of the code, so it is part of the
 * width.
 */
export function widthOfSpan(modules: number, module: number = FLOOR): number {
  return (modules + QUIET * 2) * module;
}

/**
 * How wide this value's code has to be drawn.
 *
 * **The number a caller sizes its layout from**, so the layout and the code
 * can never disagree about how big one module is. A dialog that writes its own
 * width down instead does not break loudly when a release tag grows: the URL
 * tips to the next QR version, the module count jumps from 41 to 45, and the
 * code quietly drops to 3.7px per module inside a box that still looks right.
 */
export function codeWidth(value: string, module: number = FLOOR): number {
  return widthOfSpan(encode(value).modules, module);
}

export function QrCode({
  value,
  /** What a screen reader says instead of reading out a URL character by character. */
  label,
  /**
   * How wide to draw it, for the caller that has two codes to keep the same
   * size — two codes side by side at different sizes read as a mistake, and
   * the longer payload is the one that sets the box.
   *
   * **Clamped up to this value's own floor**, never down: a box too small for
   * the payload in it is the failure this whole arithmetic exists to prevent,
   * so it is not something a caller can ask for.
   */
  width,
  module = FLOOR,
  testid,
  className = "",
}: {
  value: string;
  label: string;
  width?: number;
  module?: number;
  testid?: string;
  className?: string;
}) {
  const code = useMemo(() => encode(value), [value]);
  const box = Math.max(width ?? 0, widthOfSpan(code.modules, module));

  return (
    <svg
      width={box}
      height={box}
      viewBox={`0 0 ${code.span} ${code.span}`}
      role="img"
      aria-label={label}
      data-testid={testid}
      className={`qr ${className}`}
      shapeRendering="geometricPrecision"
    >
      {/* The plate. A code needs a light field around it, and the window may be
          either colour, so the field is an object rather than the window
          showing through — and its colour is `.qr`'s, not the theme's. */}
      <rect className="plate" width={code.span} height={code.span} rx={QUIET} />
      <g className="ink">
        <path d={code.data} />
        {/* The three corners, drawn as shapes rather than as modules. They are
            the part of a code the eye actually reads as a code, and a ring and
            a pupil are what makes one look considered instead of generated. */}
        {code.eyes.map(([x, y]) => (
          <g key={`${x},${y}`}>
            <rect className="ink-s" x={x + 0.5} y={y + 0.5} width={6} height={6} rx={2} strokeWidth={1} />
            <rect x={x + 2} y={y + 2} width={3} height={3} rx={1} />
          </g>
        ))}
      </g>
    </svg>
  );
}

/**
 * The matrix, as one path and three corner positions.
 *
 * Correction level M — a quarter of the code can be lost and still read, which
 * covers a thumb over one edge and a phone held at an angle, without pushing
 * the grid finer than a camera across a desk can resolve.
 */
function encode(value: string) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();

  const n = qr.getModuleCount();
  const eyes: [number, number][] = [
    [QUIET, QUIET],
    [QUIET + n - 7, QUIET],
    [QUIET, QUIET + n - 7],
  ];
  // The 7×7 blocks the corners occupy, skipped by the loop below so the two
  // are never drawn on top of each other.
  const corner = (r: number, c: number) =>
    (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  let data = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c) || corner(r, c)) continue;
      data += `M${QUIET + c + R} ${QUIET + r}${MODULE}`;
    }
  }

  return { modules: n, span: n + QUIET * 2, data, eyes };
}
