/**
 * What this Firetower is set up with.
 *
 * The desk's `Configuration` page, at the width a phone has and with almost
 * all of it left behind: machines, connections, agents and the vault are
 * things you touch on the first day from a desk, and both other clients do
 * them well. What is here is the one piece that is not a desk job —
 * repositories — because the new-workspace form asks for one, and a client
 * that cannot produce one answers *start work on that* with *go and find a
 * laptop*. That is the one thing the phone exists not to be.
 *
 * ## Why this is not on `You`
 *
 * It was, for an afternoon, and it read wrong for a reason worth writing down:
 * the two belong to different things. `You` is **this phone's** — which
 * Firetowers it knows about, which one is current, who you are on it, and all
 * of that survives every server in the list going away. This is **one
 * server's**, it is the same for everybody signed into it, and it changes when
 * you switch. Stacking a server's repositories under a list of servers puts a
 * thing and the things inside it at the same level, and a section legend is
 * not enough to say which is which.
 *
 * So: a tab of its own, named the way the desk names it, with the
 * organisation under the title to say whose configuration this is — because
 * the answer changes the moment somebody switches server on `You`.
 *
 * ## One section, and it says so
 *
 * A page with a single row would rather be a row somewhere else. This is not
 * that: it is the page the desk has, with the sections that are a desk job
 * absent — and it says which those are rather than drawing them greyed out.
 * A hard-coded row that opens nothing is a picture of a control.
 */
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FolderGit2, Plus } from "lucide-react-native";
import { getListReposQueryKey } from "~/api/generated/repos/repos";
import { useRepos } from "~/data";
import { useServer } from "~/native/current";
import { Waiting } from "~/ui/Waiting";
import { color } from "~/design/tokens.generated";

export default function Config() {
  const insets = useSafeAreaInsets();
  const cache = useQueryClient();
  const here = useServer();
  const repos = useRepos();

  return (
    <ScrollView
      className="flex-1 bg-ground"
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }}
      refreshControl={
        <RefreshControl
          refreshing={false}
          tintColor={color.mute}
          onRefresh={() => cache.invalidateQueries({ queryKey: getListReposQueryKey() })}
        />
      }
    >
      <Text className="px-4 font-semibold text-display text-bone">Config</Text>
      {/* Whose. Everything below belongs to one server, and which one is a
          thing you change on the tab next door. */}
      <Text className="mt-0.5 px-4 font-sans text-ui text-dim">{here?.org ?? "—"}</Text>

      <Text className="mb-2 mt-6 px-4 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
        Repositories
      </Text>

      <View className="px-2">
        {/* Four states, and the first is the one usually left out: nothing
            has come back yet, so there is nothing true to say. "None yet"
            printed over a request still in flight is the empty state that
            costs the most trust. */}
        {repos.loading && repos.data.length === 0 ? (
          <View className="px-3 py-2">
            <Waiting say="Reading the repositories" align="left" />
          </View>
        ) : repos.error ? (
          <Text className="px-3 py-3 font-sans text-ui text-brick">{repos.error}</Text>
        ) : repos.data.length === 0 ? (
          /* The first thing anybody sets up, and the only one of these
             sections a phone has. Said plainly rather than left as a gap
             above a dashed row. */
          <Text className="px-3 py-2 font-sans text-ui text-mute">
            None yet. A workspace is cut from a repository, so this is where the work starts.
          </Text>
        ) : (
          repos.data.map((repo) => (
            <Pressable
              key={repo.id}
              testID="config-repo"
              onPress={() => router.push("/repos")}
              style={{ minHeight: 56 }}
              className="flex-row items-center gap-3 rounded-lg px-3 py-3"
              android_ripple={{ color: color.overlay }}
            >
              <View className="h-10 w-10 items-center justify-center rounded-md bg-raise">
                <FolderGit2 color={color.dim} size={17} />
              </View>
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="font-mono text-ui text-bone">
                  {repo.slug}
                </Text>
                {/* Absent until a worker has read the remote, and a guessed
                    `main` printed as a fact is the kind of small lie that
                    makes the rest of a screen less believable. */}
                {repo.defaultBranch ? (
                  <Text numberOfLines={1} className="mt-0.5 font-mono text-meta text-mute">
                    {repo.defaultBranch}
                  </Text>
                ) : null}
              </View>
              <ChevronRight color={color.mute} size={16} />
            </Pressable>
          ))
        )}

        <Pressable
          testID="connect-a-repository"
          onPress={() => router.push("/repos")}
          style={{ minHeight: 56 }}
          className="mt-1 flex-row items-center gap-3 rounded-lg px-3 py-3"
          android_ripple={{ color: color.overlay }}
        >
          <View className="h-10 w-10 items-center justify-center rounded-md border border-dashed border-line">
            <Plus color={color.dim} size={18} />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="font-medium text-title text-dim">Connect a repository</Text>
            <Text numberOfLines={1} className="mt-0.5 font-sans text-meta text-mute">
              From what your git account can see
            </Text>
          </View>
        </Pressable>
      </View>

      {/* Said rather than drawn. Rows for machines, secrets and users that
          opened nothing would be five pictures of controls. */}
      <View className="mt-8 px-5">
        <Text className="font-sans text-meta text-mute">
          Machines, secrets, agent accounts and updates are set up from the desktop or the web
          console. They are a first-day job, and both of those have room for them.
        </Text>
      </View>
    </ScrollView>
  );
}
