/**
 * Waiting for something, said out loud.
 *
 * Every screen here had an `ActivityIndicator` in `--color-mute`, and every
 * one read as a hang. Three reasons, and the fix is one component because the
 * reasons are the same everywhere:
 *
 * - **It said nothing.** A spinner names neither what is being fetched nor
 *   whose fault it is if it never comes. `Sheen` is already this app's way of
 *   saying *this is not finished yet* — it sweeps per glyph off one clock, so
 *   it is visibly alive, and its own docblock is the argument: a spinner on
 *   something that may take four minutes reads as a hang.
 * - **It was invisible.** `--color-mute` is #5e5e67 on #0b0b0c.
 * - **It appeared instantly**, so a fast load flashed a spinner, which is its
 *   own kind of broken. Nothing shows for the first third of a second.
 *
 * And the one that is not about looks: past `SLOW` it says **"Still going."**
 * That is the whole question somebody is actually asking when they stare at a
 * loading screen, and no amount of animation answers it — only a sentence
 * that appeared *because* time passed can.
 *
 * It drew the transcript's shape in skeleton bars underneath for about a day.
 * They were the first thing to go once somebody saw them: a skeleton promises
 * a specific layout is about to appear in a specific place, and next to one
 * sweeping line that says exactly what is happening, it was scaffolding around
 * a sentence that did the job alone.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Sheen } from "~/ui/Sheen";

/** Under this, a load is not worth telling anybody about. */
const HOLD = 350;
/** Past this, somebody is wondering whether it is stuck. */
const SLOW = 6000;

export function Waiting({ say }: { say: string }) {
  const [shown, setShown] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const a = setTimeout(() => setShown(true), HOLD);
    const b = setTimeout(() => setSlow(true), SLOW);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, []);

  if (!shown) return null;

  return (
    <View className="items-center gap-1.5 py-6">
      <Sheen text={say} />
      {/* Said only once enough time has passed for it to be the question. */}
      {slow ? <Text className="font-sans text-meta text-mute">Still going.</Text> : null}
    </View>
  );
}
