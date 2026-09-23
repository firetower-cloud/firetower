/**
 * The one loud thing on the screen.
 *
 * The agent is genuinely stopped while this is up — the tool call is held open
 * on the host — and it can sit there for hours; the session picks up where it
 * was. So this gets the ember, the only saturated surface in the view, and the
 * question at lede size. Nothing else in the app may use ember.
 *
 * The two buttons are 48pt and far apart. This is the one place in Firetower
 * where a mis-tap runs a command somebody did not agree to.
 */
import { Pressable, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import type { Asked } from "~/api/conversation";
import { Code } from "~/ui/Prose";

/**
 * The part of a request worth reading before deciding.
 *
 * The same four keys the desk reads, and the same fallback. An agent's tool
 * arguments are not a schema we control, so this looks for the field that is
 * the *point* of the call and prints the whole thing when it cannot find one —
 * a card that says nothing is worse than a card that says too much, when what
 * it is guarding is a command about to run on your machine.
 */
function what(asked: Asked): string {
  const args = asked.args as Record<string, unknown> | undefined;
  for (const key of ["command", "file_path", "path", "url"]) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return JSON.stringify(asked.args ?? {}, null, 2);
}

const WHAT: Record<Asked["kind"], string> = {
  CommandExecution: "wants to run a command",
  FileRead: "wants to read a file",
  FileChange: "wants to change a file",
  Tool: "wants to use a tool",
};

export function Approval({ asked, onAnswer }: { asked: Asked; onAnswer: (yes: boolean) => void }) {
  const press = (yes: boolean) => {
    Haptics.impactAsync(
      yes ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
    );
    onAnswer(yes);
  };

  return (
    <View className="mx-3 mb-2 overflow-hidden rounded-lg border border-ember-deep bg-ember-tint">
      <View className="gap-3 px-4 pb-4 pt-3.5">
        <Text className="font-narrow text-micro uppercase tracking-[0.18em] text-ember-soft">
          {WHAT[asked.kind]}
        </Text>

        {/* The question, at lede size. It is what you came back to answer. */}
        <Text className="font-medium text-title leading-[24px] text-bone">{asked.detail}</Text>

        <Code text={what(asked)} />

        <View className="mt-1 flex-row gap-3">
          <Pressable
            onPress={() => press(false)}
            className="h-12 flex-1 items-center justify-center rounded-md border border-line bg-ground"
          >
            <Text className="font-medium text-ui text-text">No</Text>
          </Pressable>
          <Pressable
            onPress={() => press(true)}
            className="h-12 flex-1 items-center justify-center rounded-md bg-ember"
          >
            <Text className="font-semibold text-ui text-ground">Allow</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
