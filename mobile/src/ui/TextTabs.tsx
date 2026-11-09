/**
 * Text tabs, which is what the redesign uses instead of a recessed track.
 *
 * `Segmented` draws a filled pill inside a sunk rail — iOS's own
 * `UISegmentedControl` shape. It is right for a *filter over one list*, where
 * the options are values of the same thing and the control is a setting. It is
 * wrong for a *destination*, where the options are different pages and the
 * control is navigation: a pill inside a rail is a switch, and a switch
 * implies the thing behind it stays put.
 *
 * Diff / Files / Ship, GitHub / Linear and All / Mine / Shared are all
 * destinations. They get a name, underlined when it is the one you are on —
 * the drawing's own note is *"text tabs rather than a recessed track, and no
 * rule where space will do"*.
 *
 * The underline is `inset 0 -2px 0` rather than a border, so the unselected
 * tabs reserve exactly the same height and nothing shifts by two points when
 * you move between them.
 */
import { Pressable, Text, View } from "react-native";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

export function TextTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (next: T) => void;
}) {
  const { color } = useTheme();
  return (
    <View className="flex-row gap-6 px-5 pb-4">
      {options.map(([id, label]) => {
        const on = id === value;
        return (
          <Pressable
            key={id}
            testID={`tab-${id}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(id)}
            /* The whole 44pt touch floor, with the label sitting at the top of
               it — the underline has to hug the word, not the hit area. */
            hitSlop={{ top: 10, bottom: 10 }}
            style={{
              paddingBottom: 8,
              borderBottomWidth: 2,
              borderBottomColor: on ? color.bone : "transparent",
            }}
          >
            <Text
              className={`${on ? "font-medium text-bone" : "font-sans text-mute"}`}
              style={{ fontSize: size.title, letterSpacing: size.title * -0.008 }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
