/**
 * Three blocks of four, and the empty one walks.
 *
 * Four quadrants with one of them away, and which one moves clockwise — so
 * the shape turns without anything rotating. That matters at eleven pixels,
 * where a rotating square spends most of every turn as a grey smudge and a
 * quadrant blinking out stays a crisp edge the whole way round.
 *
 * The states are the ones in `BEAT` — the single table that says what a
 * status means — so this and `Signal` cannot disagree about a colour again.
 * Each says what it is by how it moves and not only by how it is coloured:
 * working turns, blocked breathes, done and broken are perfectly still.
 * Movement means work is happening, which is why the state that is stuck is
 * the one that does not move, however loud it is.
 */
import type { Beat } from "~/api/view";

export function Blocks({ beat, size = 11 }: { beat: Beat; size?: number }) {
  return (
    <span className="blocks" data-beat={beat} style={{ width: size, height: size }} aria-hidden>
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
