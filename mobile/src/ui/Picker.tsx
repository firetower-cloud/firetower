/**
 * One choice, from a list that does not fit inline.
 *
 * A phone has no room for six radio rows per field, and a native `<select>`
 * has no equivalent here worth using — so a field shows what is chosen and
 * opens a panel to change it. The panel is the platform's shape: it comes up
 * from the bottom, it is dismissed by tapping away or by the back gesture, and
 * it never traps you.
 */
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, ChevronDown } from "lucide-react-native";
import { color } from "~/design/tokens.generated";

export type Choice = {
  id: string;
  label: string;
  detail?: string;
  /** Shown, but not choosable, and it says why. */
  blocked?: string;
};

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="gap-2">
      {/* The hint is the one that gives way. Both sides sized naturally and
          the row was a hair from colliding once the phone scale went up — and
          the label is the half you have to be able to read. */}
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="font-sans text-ui text-dim">{label}</Text>
        {hint ? (
          <Text numberOfLines={1} className="shrink font-sans text-meta text-mute">
            {hint}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

export function Trigger({
  value,
  placeholder,
  onPress,
}: {
  value?: string;
  placeholder: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{ minHeight: 48 }}
      className="flex-row items-center justify-between rounded-xl border border-line bg-ground px-3.5 py-3"
      android_ripple={{ color: color.overlay }}
    >
      <Text numberOfLines={1} className={`flex-1 font-sans text-ui ${value ? "text-bone" : "text-mute"}`}>
        {value ?? placeholder}
      </Text>
      <ChevronDown color={color.mute} size={15} />
    </Pressable>
  );
}

export function Picker({
  open,
  title,
  choices,
  chosen,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  choices: Choice[];
  chosen?: string | string[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const has = (id: string) =>
    Array.isArray(chosen) ? chosen.includes(id) : chosen === id;

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      {/* Tapping away closes it. A panel with only one way out is one people
          get stuck in. */}
      <Pressable className="flex-1 bg-black/60" onPress={onClose} />
      <View
        className="rounded-t-2xl border-t border-line bg-panel"
        style={{ paddingBottom: insets.bottom + 8, maxHeight: "72%" }}
      >
        <View className="items-center pb-1 pt-2.5">
          <View className="h-1 w-9 rounded-full bg-mute" />
        </View>
        <Text className="px-5 pb-2 pt-1 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
          {title}
        </Text>
        <ScrollView>
          {choices.map((c) => (
            <Pressable
              key={c.id}
              disabled={!!c.blocked}
              onPress={() => onPick(c.id)}
              className="flex-row items-center gap-3 px-5 py-3.5"
              android_ripple={{ color: color.overlay }}
            >
              <View className="min-w-0 flex-1">
                <Text
                  numberOfLines={1}
                  className={`font-medium text-title ${c.blocked ? "text-mute" : "text-bone"}`}
                >
                  {c.label}
                </Text>
                {c.detail || c.blocked ? (
                  <Text numberOfLines={1} className="mt-0.5 font-sans text-meta text-mute">
                    {c.blocked ?? c.detail}
                  </Text>
                ) : null}
              </View>
              {has(c.id) ? <Check color={color.sage} size={17} /> : null}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
