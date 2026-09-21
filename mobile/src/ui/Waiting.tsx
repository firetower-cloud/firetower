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
 * It grew a second line after six seconds saying "Still going." for about a
 * day. The intent was to answer *is this stuck* — but the sweep already
 * answers that continuously, and a caption that appears on its own is a small
 * alarm going off. The sentence that is already moving says more than a
 * second sentence about the first one.
 *
 * It drew the transcript's shape in skeleton bars underneath for about a day.
 * They were the first thing to go once somebody saw them: a skeleton promises
 * a specific layout is about to appear in a specific place, and next to one
 * sweeping line that says exactly what is happening, it was scaffolding around
 * a sentence that did the job alone.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Sheen } from "~/ui/Sheen";

/** Under this, a load is not worth telling anybody about. */
const HOLD = 350;

export function Waiting({
  say,
  /**
   * Where it sits.
   *
   * A screen waiting for its whole contents centres, because the wait *is*
   * the screen. Something opening inside a list does not: a folder expanding
   * belongs to the row above it, and a centred word floating over a file tree
   * reads as a different, larger thing happening.
   */
  align = "center",
}: {
  say: string;
  align?: "center" | "left";
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShown(true), HOLD);
    return () => clearTimeout(t);
  }, []);

  if (!shown) return null;

  return (
    <View className={align === "center" ? "items-center py-6" : "items-start py-1"}>
      <Sheen text={say} />
    </View>
  );
}
