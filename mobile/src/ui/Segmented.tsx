/**
 * A recessed track with a raised knob — the platform's shape.
 *
 * The desktop's note applies unchanged: two flat buttons that swap colour is a
 * web tab bar wearing a different hat. The knob is what makes it read as a
 * control rather than as links.
 */
import { Pressable, Text, View } from "react-native";
import * as Haptics from "expo-haptics";

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: [T, string][];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View className="flex-row rounded-lg bg-ground p-[3px]">
      {options.map(([id, label]) => {
        const on = id === value;
        return (
          <Pressable
            key={id}
            onPress={() => {
              if (!on) Haptics.selectionAsync();
              onChange(id);
            }}
            className={`h-9 flex-1 items-center justify-center rounded-md ${on ? "bg-overlay" : ""}`}
            style={on ? { shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } } : undefined}
          >
            <Text className={`font-medium text-ui ${on ? "text-bone" : "text-dim"}`}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
