import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function Tasks() {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-ground px-4" style={{ paddingTop: insets.top + 8 }}>
      <Text className="font-semibold text-display text-bone">Tasks</Text>
      <Text className="mt-1 font-sans text-ui text-dim">Trackers land here — Phase 5.</Text>
    </View>
  );
}
