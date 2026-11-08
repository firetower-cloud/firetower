/**
 * What an attached file is, in the two places something can be attached.
 *
 * The conversation's composer had all of this to itself until the New page
 * needed to take a dropped file as well. Both screens have to agree on the
 * limits, on what a refusal says, and on what the row of chips looks like —
 * three things that drift silently if each screen keeps its own copy, and the
 * limits are the ones that matter: the file cap is also enforced on the worker,
 * and a client that offers more only moves the refusal to after the upload.
 *
 * The two screens differ in one way, and it is why `Chip` carries both a
 * `file` and an `image`. In a conversation there is a session, so a
 * non-picture goes straight into the workspace and the chip remembers the path
 * it landed at. On the New page there is no session yet — it does not exist
 * until the workspace is made — so the `File` waits here in memory and is put
 * in the workspace by `~/workspace/outbox` once there is one.
 */
import { useState } from "react";
import { CircleAlert, FileText, FileUp, ImageOff, Loader2, X } from "lucide-react";
import type { Artifact, Attached } from "~/api/generated/model";
import { ArtifactShot } from "~/components/ArtifactShot";

/**
 * One attached thing, from the moment it is dropped.
 *
 * A chip appears before its upload finishes, so ten files read as ten things
 * happening rather than as nothing happening and then ten things existing. It
 * carries its own identity because removing one used to be an index sum — the
 * chip's position, counted against a second array of images — and that sum is
 * the kind that is wrong exactly when it matters, with a mixed batch.
 */
export type Chip = {
  id: number;
  name: string;
  kind: "image" | "file" | "artifact";
  size: string;
  /** A thumbnail, for a picture. */
  url?: string;
  /** Where it landed in the workspace, once it has. */
  path?: string;
  /** The bytes that ride inside the message, for a picture. */
  image?: Attached;
  /** Still being read, or still on its way to the workspace. */
  pending?: boolean;
  /** The artifact this stands for, and the handle the sentence refers to it by. */
  artifact?: Artifact;
  handle?: string;
  /**
   * The file itself, still waiting for somewhere to go.
   *
   * Only on the New page, and only until the workspace exists. A chip in a
   * conversation has a `path` instead, because there was somewhere to put it.
   */
  file?: File;
  /**
   * Why it never arrived, said on the chip itself.
   *
   * Only for a card's attachment, which is fetched rather than dropped and
   * can fail on the way. A failed chip carries neither `image` nor `file`, so
   * nothing is sent for it and starting is never held up by it.
   */
  failed?: string;
};

/**
 * Attaching files from outside the composer.
 *
 * The drop surface is the whole chat pane, which is a level up — but the rules
 * for what a file becomes, the chips, the size limits and the refusal line all
 * live here and should stay in one place. So the pane borrows this rather than
 * the state moving up to meet it. `refusals` is for things the caller already
 * knows are no good, a dropped folder being the only one so far.
 */
export type Hand = (files: File[], refusals?: string[]) => void;

export const BIGGEST_IMAGE = 5 * 1024 * 1024;
/** Must match `attachments::BIGGEST` on the worker, which enforces it. */
export const BIGGEST_FILE = 25 * 1024 * 1024;

/**
 * The most one message carries.
 *
 * A cap on the message rather than on the gesture: a second drop fills what is
 * left, so this cannot be walked around by dropping twice. Ten is more than
 * any real ask and few enough that a mis-aimed multi-select cannot start a
 * hundred uploads — they go one at a time, and there is no way to call them
 * back once started.
 */
export const MOST = 10;

/**
 * How many of these will fit, and what to say about the ones that will not.
 *
 * Exported for its own test: the arithmetic is off-by-one bait, and the case
 * that matters — a batch that is partly accepted — is the one nobody tries by
 * hand.
 */
export function roomFor(held: number, offered: string[]): { fit: number; refusals: string[] } {
  const room = Math.max(0, MOST - held);
  if (offered.length <= room) return { fit: offered.length, refusals: [] };
  const over = offered.slice(room);
  const rest = over.length - 1;
  const named =
    rest === 0 ? `${over[0]} was` : `${over[0]} and ${rest} other${rest === 1 ? "" : "s"} were`;
  return { fit: room, refusals: [`${MOST} files at a time — ${named} not taken.`] };
}

export const megabytes = (n: number) => `${n / 1024 / 1024} MB`;

/**
 * Which of a batch are taken, and everything there is to say about the rest.
 *
 * Both rules at once, in the order that matters: too big is decided before too
 * many, so a message with one slot left and an oversize file offered hears
 * about the size rather than about the slot. Said all together because every
 * refusal here is reached before a single byte has moved — hearing about it
 * after ten uploads have finished is hearing about it too late to do anything.
 *
 * Pure, and the only place the two caps are applied. The New page and the
 * conversation differ in what they then *do* with a file; they must not differ
 * in which ones they accept.
 */
export function sift(
  held: number,
  offered: File[],
  known: string[] = [],
): { taken: File[]; refusals: string[] } {
  const refusals = [...known];

  const sized = offered.filter((file) => {
    const cap = file.type.startsWith("image/") ? BIGGEST_IMAGE : BIGGEST_FILE;
    if (file.size <= cap) return true;
    refusals.push(`${file.name} is over ${megabytes(cap)}.`);
    return false;
  });

  const room = roomFor(
    held,
    sized.map((f) => f.name),
  );
  refusals.push(...room.refusals);
  return { taken: sized.slice(0, room.fit), refusals };
}

/**
 * What the drop overlay says you can give it.
 *
 * There is no allowlist to recite — no `accept` on the picker and no type check
 * in `take` beyond picture-or-not — so the only thing worth saying in advance is
 * the size a file has to be under. Stated here, next to the numbers that
 * enforce it, so the two cannot drift.
 */
export const TAKES = `Up to ${MOST} files — images to ${megabytes(BIGGEST_IMAGE)}, everything else to ${megabytes(BIGGEST_FILE)}`;

/** A file's bytes, base64, without the data-url prefix. */
export function base64(file: File): Promise<string> {
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onerror = () => fail(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      done(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

/** The chip a file becomes the moment it is taken, before anything has moved. */
export function chipFor(id: number, file: File, pending: boolean): Chip {
  const picture = file.type.startsWith("image/");
  return {
    id,
    name: file.name,
    kind: picture ? "image" : "file",
    size: size(file.size),
    url: picture ? URL.createObjectURL(file) : undefined,
    pending,
  };
}

/**
 * What is on the message, above the box.
 *
 * One of these rather than one per screen, because a chip is the only thing
 * that says what is about to be sent and two of them would disagree about it
 * within a release.
 */
export function Chips({
  chips,
  onDrop,
  /** Where the row sits in its card. The New page's card pads itself; the
   *  conversation's does not, so the row supplies it there. */
  className = "px-3 pt-3",
}: {
  chips: Chip[];
  onDrop: (c: Chip) => void;
  className?: string;
}) {
  /* Chips whose thumbnail would not decode. A file can carry an `image/*` type
     and not be a picture — truncated, renamed, or written by something that
     guessed — and the browser's answer to that is a torn-page glyph that reads
     as the app being broken rather than the file. */
  const [unreadable, setUnreadable] = useState<Set<number>>(new Set());
  if (chips.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {chips.map((c) => (
        <span key={c.id} className="flex items-center gap-2 rounded-lg border border-line bg-raise py-1 pr-1 pl-2">
          {/* The thumbnail stays visible under the spinner: dimming it
              says "not yet" without taking away what you dropped. */}
          <span className={`relative grid h-7 shrink-0 place-items-center overflow-hidden rounded bg-ground text-mute ${c.kind === "artifact" ? "w-11" : "w-7"}`}>
            {c.artifact && (
              /* The picture the library draws, dimmed the way a
                 thumbnail is while its bytes are on their way. */
              <ArtifactShot artifact={c.artifact} framed={false} className={c.pending ? "opacity-30" : ""} />
            )}
            {c.url && !unreadable.has(c.id) && (
              <img
                src={c.url}
                alt=""
                onError={() => setUnreadable((was) => new Set(was).add(c.id))}
                className={`h-7 w-7 rounded object-cover ${c.pending ? "opacity-30" : ""}`}
              />
            )}
            {c.pending ? (
              <Loader2 className="absolute h-3.5 w-3.5 animate-spin text-bone" strokeWidth={2.5} />
            ) : c.failed ? (
              <CircleAlert aria-label={c.failed} className="h-3.5 w-3.5 text-brick" strokeWidth={1.75} />
            ) : unreadable.has(c.id) ? (
              /* Says which of the two went wrong: the picture, not the app. */
              <ImageOff className="h-3.5 w-3.5 text-brick" strokeWidth={1.75} />
            ) : (
              !c.url && !c.artifact && <FileText className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </span>
          {/* The name, not the path. Every attachment lands in the same
              directory, so a truncated path makes eight files read as
              eight identical chips — and the path is spelled out in the
              message itself the moment this is sent. */}
          <span
            title={c.failed ?? c.path ?? c.name}
            className={`max-w-[11rem] truncate text-meta ${c.kind === "artifact" ? "" : "font-mono"} ${c.pending || c.failed ? "text-mute" : "text-text"}`}
          >
            {c.name}
          </span>
          {c.failed ? (
            <span className="text-micro text-brick">Not brought</span>
          ) : (
            <span className={`text-micro text-mute ${c.kind === "artifact" ? "font-mono" : ""}`}>{c.size}</span>
          )}
          <button onClick={() => onDrop(c)} aria-label={`Remove ${c.name}`} className="grid h-5 w-5 place-items-center rounded text-mute hover:bg-overlay hover:text-bone">
            <X className="h-3 w-3" strokeWidth={2} />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * The overlay, while a file is over something that will take it.
 *
 * Both surfaces that accept a drop draw this, because a drop that looks
 * different on two screens reads as one of them not meaning it.
 */
export function Dropping() {
  return (
    <div className="pointer-events-none absolute inset-2 z-40 grid place-items-center rounded-2xl border border-slate bg-ground/45">
      {/* The limit, not the routing. Where a file ends up is shown for
          real a moment later — the chip names the path it landed at. */}
      <span className="flex items-center gap-2.5 rounded-xl border border-line lift px-4 py-2.5 shadow-(--shadow-float)">
        <FileUp className="h-4 w-4 text-slate" strokeWidth={1.75} />
        <span>
          <span className="block text-ui text-bone">Drop to attach</span>
          <span className="block text-meta text-mute">{TAKES}</span>
        </span>
      </span>
    </div>
  );
}
