/**
 * Connecting a repository, from the phone.
 *
 * A repository approved on the desktop appeared here immediately, and one that
 * had never been connected could not be added at all — so the form asked for
 * something this client had no way to produce. That is what this screen is:
 * not a fleet-administration page, which is a desk job and stays one, but the
 * one step of it that stands between somebody and starting work.
 *
 * ## Nothing is authorized here
 *
 * The control plane already holds this person's git token — they connected
 * GitHub once, on a desk, and `/providers/github/repos` is the list that came
 * with it. So connecting a repository is a `POST /repos` with a slug and a
 * remote off that list, and there is deliberately no device flow on the phone:
 * a code to type into a browser on another device, from a device that *is* the
 * browser, is the worst place to run that flow and the desktop already runs it
 * well. A phone with no connected account is told so, and told where it is
 * done.
 *
 * ## Why it is a page and not a sheet
 *
 * The picker on the form is a sheet, and this opens from it. A sheet over a
 * sheet is a stack with no back gesture — and this one holds a list of a
 * hundred rows, a filter, and an action. That is a page.
 *
 * ## Coming back
 *
 * Reached from the form, what was just connected is chosen on it when you get
 * back. Those repositories are the only reason anybody came here; making them
 * reopen the picker to find rows they created ten seconds ago is the kind of
 * small friction that reads as the feature not being finished. `pick` is what
 * says the form is behind us — see `workspace/connected.ts`.
 */
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, FolderGit2, Lock } from "lucide-react-native";
import { getListReposQueryKey, useCreateRepo } from "~/api/generated/repos/repos";
import { getListProviderReposQueryKey } from "~/api/generated/providers/providers";
import type { RemoteRepo } from "~/api/generated/model";
import { importable, matching, repoName, repoOwner, worthFiltering } from "~/api/repos";
import { elapsed, minutesSince } from "~/api/view";
import { useProviderRepos, useProviders, useRepos, why } from "~/data";
import { leaveConnected } from "~/workspace/connected";
import { Waiting } from "~/ui/Waiting";
import { color, size } from "~/design/tokens.generated";

export default function Repos() {
  const insets = useSafeAreaInsets();
  const cache = useQueryClient();
  const { pick } = useLocalSearchParams<{ pick?: string }>();

  /* Whichever git host this person has authorized. One today; the shape is
     the contract's, so a second one is a row in that list rather than a
     branch here. */
  const providers = useProviders();
  const host = providers.data.find((p) => p.connected);
  /**
   * Whether there is anything to authorize against at all.
   *
   * The contract splits these and so does the desk: `configured` is false when
   * nobody has registered an OAuth application for this install, which is a
   * setup problem and not something the person holding the phone did — and
   * telling them to "authorize on the desktop" sends them to a screen that
   * cannot do it either, because it will ask *them* for a client id.
   */
  const settable = providers.data.some((p) => p.configured);

  const connected = useRepos();
  const offered = useProviderRepos(host?.id ?? null);
  const create = useCreateRepo();

  const [typed, setTyped] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<string | null>(null);

  const all = useMemo(
    () => importable(offered.data, connected.data),
    [offered.data, connected.data],
  );
  const left = useMemo(() => matching(all, typed), [all, typed]);
  /* Asked of everything on offer rather than of what the box has narrowed it
     to: a filter that takes itself away as soon as it has been used is one you
     cannot undo. */
  const filtering = worthFiltering(all.length);

  /* Nothing is drawn until both halves have come back — see the note over the
     list. `loading` is the query's first flight only, so a refresh pulled down
     on a screen that already has rows leaves them where they are. */
  const waiting =
    providers.loading ||
    connected.loading ||
    (!!host && offered.loading && offered.data.length === 0);

  const ready = chosen.length > 0 && !busy;

  const connect = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setBusy(true);
    setWrong(null);

    /* One at a time, and each is its own answer. `POST /repos` reaches for the
       remote, so three of them are three round trips whatever we do — and one
       that fails has to leave the other two connected. */
    const made: string[] = [];
    const refused: string[] = [];
    for (const repo of offered.data.filter((r) => chosen.includes(r.slug))) {
      try {
        const added = await create.mutateAsync({
          data: { slug: repo.slug, remote: repo.remote },
        });
        made.push(added.id);
      } catch (e) {
        refused.push(`${repo.slug} — ${why(e)}`);
      }
    }

    await cache.invalidateQueries({ queryKey: getListReposQueryKey() });
    setBusy(false);

    /* Said here rather than left to the empty list. The ones that worked have
       dropped out of the list on their own — they are connected now — and what
       is still selected is what did not. */
    if (refused.length > 0) {
      setWrong(refused[0]);
      setChosen((was) => was.filter((slug) => refused.some((line) => line.startsWith(`${slug} `))));
      return;
    }

    if (pick) leaveConnected(made);
    router.back();
  };

  const toggle = (slug: string) =>
    setChosen((was) => (was.includes(slug) ? was.filter((s) => s !== slug) : [...was, slug]));

  return (
    <View className="flex-1 bg-ground" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 pb-2 pl-1">
        <Pressable
          onPress={() => router.back()}
          className="h-10 w-10 items-center justify-center"
          hitSlop={8}
        >
          <ChevronLeft color={color.bone} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1 pr-3">
          <Text numberOfLines={1} className="font-medium text-title text-bone">
            Repositories
          </Text>
          <Text numberOfLines={1} className="mt-0.5 font-sans text-meta text-dim">
            {host ? `From your ${host.label} account` : "What workspaces are cut from"}
          </Text>
        </View>
      </View>

      {filtering ? (
        <View className="px-4 pb-2">
          <TextInput
            testID="filter"
            value={typed}
            onChangeText={setTyped}
            placeholder="Filter your repositories"
            placeholderTextColor={color.mute}
            selectionColor={color.ember}
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-lg bg-raise px-3.5 py-2.5 font-sans text-bone"
            style={{ fontSize: size.ui }}
          />
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 32, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={false}
            tintColor={color.mute}
            onRefresh={() => {
              if (host) cache.invalidateQueries({ queryKey: getListProviderReposQueryKey(host.id) });
              cache.invalidateQueries({ queryKey: getListReposQueryKey() });
            }}
          />
        }
      >
        {/* Five absences, and they are five different things to do about it.
            "Nothing to add" over a list that never arrived is the one that
            costs the most trust.

            Both feeds gate the list, not just the host's. What is on offer is
            *what GitHub has minus what Firetower already has*, so rendering it
            while the second half is still in flight offers rows that then
            vanish — and a row tapped in that window is a repository the server
            already has, which comes back as an error nobody can act on. */}
        {waiting ? (
          <View className="flex-1 items-center justify-center py-20">
            <Waiting say={host ? `Asking ${host.label}` : "Reading your connections"} />
          </View>
        ) : !host && !settable ? (
          <Empty
            title="No git host is set up"
            detail="Nobody has registered a GitHub application on this Firetower, so there is nothing to authorize against yet. An administrator adds the client id in the web console or the desktop app — the connect-a-repository screen there asks for one and says where to get it."
          />
        ) : !host ? (
          <Empty
            title="No git host is connected"
            detail="Firetower clones with your own account, and yours has not been authorized here yet. That is done once, in the web console or the desktop app — then your repositories show up on this screen."
          />
        ) : offered.error ? (
          <Empty title={`${host.label} did not answer`} detail={offered.error} />
        ) : connected.error ? (
          <Empty title="This Firetower did not answer" detail={connected.error} />
        ) : offered.data.length === 0 ? (
          /* Nothing came back at all, which is a different sentence from
             "you already have them". An account with no repositories says
             this, and so does one whose organisations were never granted —
             and the second is by far the likelier of the two. */
          <Empty
            title={`${host.label} showed nothing`}
            detail={`Your ${host.label} account can see no repositories Firetower could clone. Organisations you did not grant access to stay hidden — authorize it again from the web console or the desktop app and grant the ones you want.`}
          />
        ) : all.length === 0 ? (
          <Empty
            title="Everything is connected"
            detail={`Every repository ${host.label} shows you is already here. Organisations you did not grant stay hidden — authorize it again from the web console or the desktop app to add one.`}
          />
        ) : left.length === 0 ? (
          <Empty
            title="Nothing matches"
            detail={`No repository on ${host.label} is called anything like “${typed}”.`}
          />
        ) : (
          <>
            <Legend>On {host.label}</Legend>
            {left.map((repo) => (
              <Row
                key={repo.slug}
                repo={repo}
                chosen={chosen.includes(repo.slug)}
                onPress={() => toggle(repo.slug)}
              />
            ))}
          </>
        )}

        {/* Why a repository is not in the list above, answered where the
            question is asked. Dimmed and unchoosable: it is already here. */}
        {connected.data.length > 0 ? (
          <View className="mt-4">
            <Legend>Connected</Legend>
            {connected.data.map((repo) => (
              <View key={repo.id} className="flex-row items-center gap-3 px-4 py-3" style={{ minHeight: 56 }}>
                <FolderGit2 color={color.mute} size={15} />
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="font-mono text-ui text-dim">
                    {repo.slug}
                  </Text>
                  {/* The trunk is absent until something has read the remote,
                      and the desktop's `?? "main"` is a guess printed as a
                      fact. A row that says nothing is better than one that
                      names a branch this repository may not have. */}
                  {repo.defaultBranch ? (
                    <Text numberOfLines={1} className="mt-0.5 font-mono text-meta text-mute">
                      {repo.defaultBranch}
                    </Text>
                  ) : null}
                </View>
                <Check color={color.mute} size={16} />
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* Pinned, and only there once there is something to do with it — the
          same decision as the form this opens from. */}
      {chosen.length > 0 || wrong ? (
        <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
          <View
            className="border-t border-line-soft bg-ground px-4 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 10) }}
          >
            {wrong ? (
              <Text className="mb-2 text-center font-sans text-meta text-brick">{wrong}</Text>
            ) : null}
            <Pressable
              testID="connect-repos"
              disabled={!ready}
              onPress={connect}
              style={{ height: 52 }}
              className={`items-center justify-center rounded-xl ${ready ? "bg-bone" : "bg-overlay"}`}
            >
              <Text className={`font-semibold text-title ${ready ? "text-ground" : "text-mute"}`}>
                {busy
                  ? "Connecting…"
                  : chosen.length === 1
                    ? "Connect it"
                    : `Connect ${chosen.length} repositories`}
              </Text>
            </Pressable>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}

/**
 * One repository on offer.
 *
 * Two lines and a glyph, which is this app's list row. The name carries the
 * row and the owner drops to the line below it, because a screenful of
 * `acme/…` is a column of one word repeated — and the part you are looking for
 * is the other one.
 */
function Row({
  repo,
  chosen,
  onPress,
}: {
  repo: RemoteRepo;
  chosen: boolean;
  onPress: () => void;
}) {
  const owner = repoOwner(repo.slug);

  return (
    <Pressable
      testID="repo-row"
      onPress={onPress}
      style={{ minHeight: 56 }}
      className={`flex-row items-center gap-3 px-4 py-3 ${chosen ? "bg-overlay" : ""}`}
      android_ripple={{ color: color.overlay }}
    >
      <FolderGit2 color={chosen ? color.bone : color.mute} size={15} />
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="font-mono text-ui text-bone">
          {repoName(repo.slug)}
        </Text>
        {/* Real layout rather than a string of middle dots, so each part can
            give way on its own — and the one that gives way is the owner. */}
        <View className="mt-0.5 flex-row items-center gap-2">
          {owner ? (
            <Text numberOfLines={1} className="min-w-0 shrink font-mono text-meta text-mute">
              {owner}
            </Text>
          ) : null}
          {repo.private ? <Lock color={color.mute} size={10} /> : null}
          <Text className="font-mono text-meta text-mute">{repo.defaultBranch}</Text>
          {repo.pushedAt ? (
            <Text className="font-sans text-meta text-mute">
              {elapsed(minutesSince(repo.pushedAt))}
            </Text>
          ) : null}
        </View>
      </View>
      <View
        className={`h-5 w-5 items-center justify-center rounded ${
          chosen ? "bg-sage-tint" : "border border-line"
        }`}
      >
        {chosen ? <Check color={color.sage} size={13} /> : null}
      </View>
    </Pressable>
  );
}

/** The map-legend voice. One per section, and there is room for two here. */
function Legend({ children }: { children: React.ReactNode }) {
  return (
    <Text className="px-4 pb-1 pt-2 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
      {children}
    </Text>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-8 py-16">
      <Text className="text-center font-medium text-title text-bone">{title}</Text>
      <Text className="text-center font-sans text-meta text-mute">{detail}</Text>
    </View>
  );
}
