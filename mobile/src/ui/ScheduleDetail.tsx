/**
 * One schedule, on the phone.
 *
 * **Reading gets its own size.** The run lines are a step larger than the
 * desk's, because this is read at arm's length and there is one column to
 * read it in.
 *
 * **Run now and the switch are the only two writes.** Pausing the clock and
 * stopping a run are different things on the desk, and a run in flight is
 * opened as a workspace here rather than given a second button — the phone
 * already has a screen for ending one, and a second control that looks like
 * this one would be the confusion the desk separates them to avoid.
 *
 * The time and the duration are two spans with space between them, never a
 * middle-dotted string: `STYLE.md` names that as one of three habits to
 * avoid and says to use real layout.
 */
import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { ChevronLeft, Play } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListSchedulesQueryKey,
  pauseSchedule,
  resumeSchedule,
  approveSchedule,
  runScheduleNow,
  useOneSchedule,
  useScheduleRuns,
} from "~/api/generated/schedules/schedules";
import { BLEED, useEdges } from "~/ui/edges";
import { COLUMN } from "~/ui/measure";
import { Waiting } from "~/ui/Waiting";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";
import { RunMark, runLine, says, stillMoving, tagOf } from "~/ui/schedules";

/**
 * One schedule, as a screen on a phone and as the right pane on a Duo in
 * landscape.
 *
 * `framed` is the docked case: there is a list beside it, so the way back is
 * that list rather than a button, and the screen's own top inset is already
 * spent by the pane it sits in.
 */
export function Detail({ id, framed }: { id: string; framed?: boolean }) {
  const edges = useEdges({ gutter: BLEED });
  const { color } = useTheme();
  const client = useQueryClient();
  /* **The screen follows a run while one is moving.** Starting one answers
     with its id and nothing else — the launch happens off the request — so
     the state that matters arrives after the press. Without this the phone
     kept a claimed row with no sentence and never corrected itself. */
  const [moving, setMoving] = useState(false);
  const watch = moving ? 5_000 : false;
  const schedule = useOneSchedule(id, { query: { refetchInterval: watch } });
  const history = useScheduleRuns(id, { limit: 20 }, { query: { refetchInterval: watch } });
  const runs = history.data ?? [];
  useEffect(() => setMoving(stillMoving(runs)), [runs]);

  const refresh = () => {
    client.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
    schedule.refetch();
    history.refetch();
  };

  const it = schedule.data;

  return (
    <View className="flex-1 bg-ground" style={framed ? undefined : edges}>
      {framed ? (
        <View className="h-11" />
      ) : (
        <View className="h-11 flex-row items-center px-2">
          <Pressable
            testID="back"
            accessibilityRole="button"
            onPress={() => router.back()}
            className="h-11 flex-row items-center gap-1 px-3"
          >
            <ChevronLeft size={20} color={color.mute} strokeWidth={1.8} />
            <Text className="font-sans text-mute" style={{ fontSize: size.body }}>
              Schedules
            </Text>
          </Pressable>
        </View>
      )}

      {!it ? (
        <View className="items-center justify-center py-20">
          <Waiting say="Reading this schedule" />
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ flexGrow: 1, ...COLUMN }}
          refreshControl={
            <RefreshControl refreshing={false} tintColor={color.mute} onRefresh={refresh} />
          }
        >
          <Text
            className="px-5 pt-1 font-medium text-bone"
            style={{ fontSize: size.display, letterSpacing: size.display * -0.018 }}
          >
            {it.name}
          </Text>
          <Text className="px-5 pt-1 font-sans text-mute" style={{ fontSize: size.body }}>
            {it.triggers[0]?.reads} {it.triggers[0]?.timezone}
          </Text>
          {tagOf(it) ? (
            <Text className="px-5 pt-2 font-sans" style={{ fontSize: size.meta, color: color["ember-ink"] }}>
              {tagOf(it)} — it will not run again until you turn it on.
            </Text>
          ) : null}

          <View className="flex-row items-center gap-2 px-5 pt-4">
            <Pressable
              testID="run-now"
              accessibilityRole="button"
              disabled={!it.approvedAt}
              onPress={async () => {
                await runScheduleNow(it.id);
                refresh();
              }}
              className="h-11 flex-1 flex-row items-center justify-center gap-2 rounded-full bg-raise"
            >
              <Play size={14} color={color.bone} strokeWidth={1.8} />
              <Text className="font-sans text-bone" style={{ fontSize: size.body }}>
                Run now
              </Text>
            </Pressable>
            <Pressable
              testID="schedule-toggle"
              accessibilityRole="switch"
              accessibilityState={{ checked: it.active }}
              onPress={async () => {
                if (it.active) await pauseSchedule(it.id);
                else if (it.approvedAt) await resumeSchedule(it.id);
                else await approveSchedule(it.id, { revision: it.revision });
                refresh();
              }}
              hitSlop={8}
              className="h-7 w-[46px] justify-center rounded-full px-0.5"
              style={{ backgroundColor: it.active ? color.sage : color.overlay }}
            >
              <View
                className="h-6 w-6 rounded-full"
                style={{ backgroundColor: color.bone, alignSelf: it.active ? "flex-end" : "flex-start" }}
              />
            </Pressable>
          </View>

          <Text className="px-5 pt-7 pb-1 font-medium text-dim" style={{ fontSize: size.meta }}>
            Run history
          </Text>
          {runs.map((r) => (
            <View key={r.id} className="flex-row items-start gap-3 border-b border-line-soft px-5 py-3">
              <View className="pt-1">
                <RunMark run={r} />
              </View>
              <View className="min-w-0 flex-1">
                {/* **Reading gets its own size.** A run's line is the reason
                    to open this screen, and it is read at arm's length in one
                    column — so it takes `read` where the desk's list takes
                    its own smaller step. */}
                <Text className="font-sans text-body" style={{ fontSize: size.read, lineHeight: size.read * 1.4 }}>
                  {runLine(r)}
                </Text>
                <View className="flex-row gap-3.5 pt-0.5">
                  <Text className="font-sans text-mute tabular-nums" style={{ fontSize: size.micro }}>
                    {new Date(r.fireAt).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </Text>
                </View>
              </View>
            </View>
          ))}
          {runs.length === 0 ? (
            <Text className="px-5 py-3 font-sans text-mute" style={{ fontSize: size.body }}>
              {says(it) === "Waiting for you to turn it on"
                ? "It has never run. Turn it on and the first run happens at its next time."
                : "No runs yet."}
            </Text>
          ) : null}
          {/* **One scrolling page, and it says so.**

              The desktop pages this history with a 5/10/20 control, because
              there a year of daily runs is 365 rows in a window somebody is
              reading at a desk. A phone is scrolled rather than paged, and
              three taps to change a page size is a worse answer than a thumb
              — so this keeps its twenty and stops implying they are all of
              them. The desktop is where the rest is. */}
          {it.runsTotal > runs.length ? (
            <Text className="px-5 py-3 font-sans text-mute" style={{ fontSize: size.meta }}>
              The newest {runs.length} of {it.runsTotal} runs.
            </Text>
          ) : null}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </View>
  );
}
