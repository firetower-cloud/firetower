"use client";

/**
 * A link, for the phone that is already in your hand.
 *
 * Installing the phone app from the desktop is the one flow where the address
 * cannot be pasted: the link is on this screen and the device that needs it is
 * a different device. A code closes that gap in the only way that does not
 * involve typing a GitHub release URL into a phone keyboard.
 *
 * Drawn as a path rather than fetched as an image. A self-hosted Firetower is
 * often on a private network with no route to the internet, and a code served
 * from somebody else's chart API would be a broken image exactly there — on
 * the page whose whole job is to hand out the app. It also means the code is
 * vector: it stays crisp when the page is zoomed, and it is drawn in the same
 * two colours as everything else rather than in whatever the generator picked.
 */
import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * The light border around the code, in modules. The spec asks for four; three
 * scans just as well at this size and keeps the modules bigger for the same
 * width on screen, which matters more to a camera than the fourth ring does.
 */
const QUIET = 3;

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

export function QrCode({
  value,
  /** What a screen reader says instead of reading out a URL character by character. */
  label,
  size = 160,
  className = "",
}: {
  value: string;
  label: string;
  size?: number;
  className?: string;
}) {
  const code = useMemo(() => encode(value), [value]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${code.span} ${code.span}`}
      role="img"
      aria-label={label}
      className={`block ${className}`}
      shapeRendering="geometricPrecision"
    >
      {/* The plate. A code needs a light field around it, and the page is dark,
          so the field is an object on the page rather than the page showing
          through. */}
      <rect width={code.span} height={code.span} rx={QUIET} fill="var(--color-bone)" />
      <g fill="var(--color-ground)">
        <path d={code.data} />
        {/* The three corners, drawn as shapes rather than as modules. They are
            the part of a code the eye actually reads as a code, and a ring and
            a pupil are what makes one look considered instead of generated. */}
        {code.eyes.map(([x, y]) => (
          <g key={`${x},${y}`}>
            <rect
              x={x + 0.5}
              y={y + 0.5}
              width={6}
              height={6}
              rx={2}
              fill="none"
              stroke="var(--color-ground)"
              strokeWidth={1}
            />
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

  return { span: n + QUIET * 2, data, eyes };
}
