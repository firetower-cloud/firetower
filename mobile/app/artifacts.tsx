/**
 * Every artifact you can reach.
 *
 * This screen is the reason an artifact is owned by a person rather than by a
 * workspace. `reclaim.rs` deletes a workspace within a minute of its last
 * session ending and the cascade takes the conversation with it — so a list
 * spanning conversations can only exist if these rows sit outside that
 * cascade. They do: `artifacts` has foreign keys to `users` and
 * `organizations` and to nothing else.
 *
 * **A grid, and that is a considered exception to one of the house rules.**
 * `STYLE.md` names "a rounded card around everything" as a habit that makes
 * an interface look generated, and the reason it gives is that one radius on
 * every object flattens the hierarchy it was supposed to express. There is no
 * hierarchy to flatten here: one kind of object, and what identifies each one
 * is a picture. Browsing is the whole job of this screen, and you cannot
 * browse what you cannot see.
 *
 * Two columns, not the desk's auto-fill: at 390pt a third column makes every
 * poster too small to recognise, which defeats the only reason for a grid.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { ArtifactCard } from "~/ui/ArtifactCard";
import { Segmented } from "~/ui/Segmented";
import { Waiting } from "~/ui/Waiting";
import { color } from "~/design/tokens.generated";

type Scope = "all" | "mine" | "shared";
const SCOPES: [Scope, string][] = [
  ["all", "All"],
  ["mine", "Mine"],
  ["shared", "Shared"],
];

export default function Artifacts() {
  const insets = useSafeAreaInsets();
  const [scope, setScope] = useState<Scope>("all");
  const { data: everything = [], isPending, error } = useListArtifacts();

  /* `mine` is the server's word for "filed at my own root", not "I made it" —
     so the two scopes are a partition and `all` is the sum, rather than three
     overlapping filters that do not add up. */
  const shown = useMemo(
    () => everything.filter((a) => (scope === "all" ? true : scope === "mine" ? a.mine : !a.mine)),
    [everything, scope],
  );

  return (
    <View
      className="flex-1 bg-ground"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
    >
      <View className="flex-row items-center gap-1 pb-2 pl-1">
        <Pressable onPress={() => router.back()} className="h-10 w-10 items-center justify-center" hitSlop={8}>
          <ChevronLeft color={color.bone} size={22} />
        </Pressable>
        <Text className="flex-1 font-semibold text-display text-bone">Artifacts</Text>
        {everything.length ? (
          <Text className="mr-4 font-mono text-meta text-mute">{everything.length}</Text>
        ) : null}
      </View>

      <View className="px-4 pb-3">
        <Segmented options={SCOPES} value={scope} onChange={setScope} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}>
        <View className="flex-row flex-wrap gap-x-3 gap-y-1 px-4">
          {shown.map((a) => (
            <View key={a.id} className="w-[47%]">
              <ArtifactCard
                artifact={a}
                onOpen={() => router.push({ pathname: "/workspace/artifact", params: { id: a.id } })}
              />
            </View>
          ))}
        </View>

        {/* Three absences, said apart — the inbox's rule, for the same reason:
            reading "nothing here yet" when the server is unreachable is the
            lie that costs the most trust. */}
        {isPending ? (
          <View className="flex-1 items-center justify-center py-20">
            <Waiting say="Reading your artifacts" />
          </View>
        ) : error ? (
          <View className="items-center gap-2 px-8 py-16">
            <Text className="text-center font-medium text-title text-bone">That did not come back</Text>
            <Text className="text-center font-sans text-meta text-mute">{String(error)}</Text>
          </View>
        ) : shown.length === 0 ? (
          <View className="items-center gap-2 px-8 py-16">
            <Text className="text-center font-sans text-ui text-dim">
              {everything.length === 0
                ? "Nothing published yet."
                : `Nothing filed as ${scope === "mine" ? "yours" : "shared"}.`}
            </Text>
            <Text className="text-center font-sans text-meta text-mute">
              An agent publishes one when you ask it to show you something.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
