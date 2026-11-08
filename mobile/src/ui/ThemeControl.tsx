/**
 * System, Light, Dark — and it belongs on **You**.
 *
 * The desk puts its theme control in a profile menu. A phone has no profile
 * menu, and You is this phone's own settings: which Firetowers it knows,
 * whether notifications are on, and now this. What they have in common is
 * that they survive every server in the list going away, which is exactly
 * what a theme does — it is not the organisation's, and it is not one
 * server's.
 *
 * **Three settings, not two.** "Follow the system" is a different answer from
 * "always light" even on a phone that happens to be light right now, and a
 * two-way switch cannot express it. Defaulting to System is most of what
 * makes an app feel like it belongs to the phone rather than to us.
 *
 * A segmented control rather than a list of rows: the three are mutually
 * exclusive, the labels are one word each, and seeing all three at once is
 * what tells you System is an option at all.
 */
import { Pressable, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { CHOICES, useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

export function ThemeControl() {
  const { choice, choose, scheme } = useTheme();

  return (
    <View className="px-3">
      <View className="flex-row gap-0.5 rounded-field bg-raise p-[3px]">
        {CHOICES.map((c) => {
          const on = c.id === choice;
          return (
            <Pressable
              key={c.id}
              testID={`theme-${c.id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              onPress={() => {
                if (on) return;
                Haptics.selectionAsync();
                choose(c.id);
              }}
              className={`h-9 flex-1 items-center justify-center rounded-seg ${on ? "bg-float" : ""}`}
              style={
                on
                  ? {
                      /* The chosen one lifts off the track. In light that is
                         the shadow's job; in dark the `float` fill does it,
                         for the reason `phone.css` gives. */
                      shadowColor: "#000",
                      shadowOpacity: 0.1,
                      shadowRadius: 2,
                      shadowOffset: { width: 0, height: 1 },
                    }
                  : undefined
              }
            >
              <Text
                className={`font-medium ${on ? "text-bone" : "text-dim"}`}
                style={{ fontSize: size.body }}
              >
                {c.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* What System currently resolves to, because otherwise the control
          gives no feedback at all when the OS already matches the choice. */}
      <Text className="px-1 pt-2 font-sans text-meta text-mute">
        {choice === "system"
          ? `Following this phone, which is ${scheme} right now.`
          : `Always ${choice}, whatever this phone is set to.`}
      </Text>
    </View>
  );
}
