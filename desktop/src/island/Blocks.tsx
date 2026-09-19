/**
 * Three blocks of four, and the empty one walks.
 *
 * Four quadrants with one of them away, and which one moves clockwise — so
 * the shape turns without anything rotating. That matters at eleven pixels,
 * where a rotating square spends most of every turn as a grey smudge and a
 * quadrant blinking out stays a crisp edge the whole way round.
 *
 * The three states are the three `doing()` answers, and each says what it is
 * by how it moves rather than only by its colour: working turns, waiting
 * breathes, idle is perfectly still. Movement means work is happening — which
 * is why the one state that is stuck does not move, however loud it is.
 */
export type Beat = "working" | "waiting" | "idle";

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
