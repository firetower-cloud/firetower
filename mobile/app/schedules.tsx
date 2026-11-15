/**
 * Schedules, on the phone.
 *
 * **A stack screen, not a tab.** Four tabs is what `NativeTabs` presents well
 * as a vertical rail on the Duo, and a fifth would be paid for on every pose
 * to reach a destination most people open weekly. The way in is a row under
 * the greeting.
 *
 * **Two scopes as text tabs, not a segmented control.** `Segmented` draws a
 * pill inside a sunk rail, which is right for a filter over one list and
 * wrong for a destination: a switch implies the thing behind it stays put,
 * and *Runs* is a different page. The desk has a panel to put the second
 * scope in; here there is none, so it is a tab on the screen.
 *
 * **This reads, pauses and runs. It does not create or edit.** Writing a
 * prompt for an agent that cannot ask a follow-up question is desk work, and
 * a sheet that asked for one on a phone would get a sentence where it wanted
 * a paragraph. The two writes the phone has are the two a thumb is good at:
 * a switch, and a button that starts one now.
 */
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListSchedulesQueryKey,
  pauseSchedule,
  resumeSchedule,
  approveSchedule,
  useAllRuns,
  useListSchedules,
} from "~/api/generated/schedules/schedules";
import type { Schedule } from "~/api/generated/model";
import { elapsed, minutesSince } from "~/api/view";
import { BLEED, useEdges } from "~/ui/edges";
import { COLUMN } from "~/ui/measure";
import { usePose } from "~/ui/pose";
import { TextTabs } from "~/ui/TextTabs";
import { Waiting } from "~/ui/Waiting";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";
import { RunMark, runLine, says, tagOf } from "~/ui/schedules";
import { Detail } from "~/ui/ScheduleDetail";

type Scope = "list" | "runs";

export default function Schedules() {
  const edges = useEdges({ gutter: BLEED });
  const { color } = useTheme();
  const client = useQueryClient();
  /**
   * **951 docks; 669 does not, and that is the whole of the rule.**
   *
   * 669 lays out in 595 once the system's trailing rail is off it, which is
   * 245 short of the dock line. A docked 300pt list there would leave 369 for
   * the schedule — narrower than the 390pt phone this came from. So it stays
   * one column and a schedule opens as its own screen, exactly as it does on
   * a phone. The shared `usePose` answers it, so this destination cannot come
   * to disagree with the rest of the app about where the line is.
   */
  const pose = usePose();
  const [scope, setScope] = useState<Scope>("list");
  const [reading, setReading] = useState<string | null>(null);
  const library = useListSchedules();
  const runs = useAllRuns({ limit: 30 });

  /* Waiting first, then the rest in the order they next run. Not grouped —
     a schedule changes state while you are looking at it, and the row you
     reached for would jump sections under your thumb. */
  const rows = useMemo(() => {
    const all = library.data ?? [];
    const wants = (s: Schedule) => (s.made.byAgent && !s.approvedAt) || (!s.active && !!s.pausedReason);
    return [...all].sort((a, b) => Number(wants(b)) - Number(wants(a)));
  }, [library.data]);

  const refresh = () => {
    client.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
    runs.refetch();
  };

  const open = (id: string) => {
    /* Docked, the schedule lands beside the list rather than over it, and the
       row you had open stays open. Everywhere else it is its own screen. */
    if (pose.docked) setReading(id);
    else router.push(`/schedule/${id}`);
  };

  const page = (
    <View className="flex-1 bg-ground" style={edges} onLayout={pose.onLayout}>
      <View className="h-11 flex-row items-center px-2">
        <Pressable
          testID="back"
          accessibilityRole="button"
          onPress={() => router.back()}
          className="h-11 flex-row items-center gap-1 px-3"
        >
          <ChevronLeft size={20} color={color.mute} strokeWidth={1.8} />
          <Text className="font-sans text-mute" style={{ fontSize: size.body }}>
            Dashboard
          </Text>
        </Pressable>
      </View>

      <Text
        className="px-5 pt-1 pb-3 font-medium text-bone"
        style={{ fontSize: size.display, letterSpacing: size.display * -0.024 }}
      >
        Schedules
      </Text>

      <TextTabs
        options={[
          ["list", "Schedules"],
          ["runs", "Runs"],
        ] as const}
        value={scope}
        onChange={setScope}
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ flexGrow: 1, ...COLUMN }}
        refreshControl={<RefreshControl refreshing={false} tintColor={color.mute} onRefresh={refresh} />}
      >
        {library.isPending ? (
          <View className="items-center justify-center py-20">
            <Waiting say="Reading your schedules" />
          </View>
        ) : scope === "list" ? (
          rows.length === 0 ? (
            <Empty />
          ) : (
            rows.map((s) => (
              <Row
                key={s.id}
                schedule={s}
                onOpen={() => open(s.id)}
                onFlip={async () => {
                  if (s.active) await pauseSchedule(s.id);
                  else if (s.approvedAt) await resumeSchedule(s.id);
                  else await approveSchedule(s.id, { revision: s.revision });
                  refresh();
                }}
              />
            ))
          )
        ) : (
          (runs.data ?? []).map((r) => (
            <Pressable
              key={r.id}
              accessibilityRole="button"
              onPress={() => open(r.scheduleId)}
              className="min-h-[54px] flex-row items-start gap-3 px-5 py-3"
            >
              <View className="pt-1">
                <RunMark run={r} />
              </View>
              <View className="min-w-0 flex-1">
                <Text className="font-sans text-bone" style={{ fontSize: size.body }} numberOfLines={1}>
                  {r.scheduleName}
                </Text>
                <Text className="font-sans text-mute" style={{ fontSize: size.meta }} numberOfLines={2}>
                  {runLine(r)}
                </Text>
              </View>
              <Text className="font-sans text-mute tabular-nums" style={{ fontSize: size.meta }}>
                {elapsed(minutesSince(r.fireAt))}
              </Text>
            </Pressable>
          ))
        )}
        <View style={{ height: 20 }} />
      </ScrollView>
    </View>
  );

  if (!pose.docked) return <View className="flex-1">{page}</View>;

  /* The only pose with room for two things at once. Unfolding from 669 moves
     the schedule you had open into the right pane; the row stays open and the
     control that opened it still does what it did. */
  return (
    <View className="flex-1 flex-row bg-ground">
      <View style={{ width: pose.panel }} className="border-r border-line-soft">
        {page}
      </View>
      <View className="min-w-0 flex-1">
        <Beside id={reading ?? rows[0]?.id} />
      </View>
    </View>
  );
}

/** The schedule the docked list has open, in the pane beside it. */
function Beside({ id }: { id?: string }) {
  if (!id) return <View className="flex-1 bg-ground" />;
  return <Detail id={id} framed />;
}

function Row({
  schedule,
  onOpen,
  onFlip,
}: {
  schedule: Schedule;
  onOpen: () => void;
  onFlip: () => void;
}) {
  const { color } = useTheme();
  const tag = tagOf(schedule);
  return (
    <Pressable
      testID="schedule-row"
      accessibilityRole="button"
      onPress={onOpen}
      className="min-h-[54px] flex-row items-center gap-3 px-5 py-2.5"
    >
      <View className="min-w-0 flex-1">
        <Text className="font-sans text-bone" style={{ fontSize: size.body }} numberOfLines={1}>
          {schedule.name}
        </Text>
        {/* **466 is not a wider 390.** The extra room buys a whole sentence
            rather than a wider abbreviation, which is what `says` decides. */}
        <Text className="font-sans text-mute" style={{ fontSize: size.meta }} numberOfLines={1}>
          {tag ?? says(schedule)}
        </Text>
      </View>
      <Pressable
        testID="schedule-toggle"
        accessibilityRole="switch"
        accessibilityState={{ checked: schedule.active }}
        onPress={onFlip}
        hitSlop={8}
        className="h-7 w-[46px] justify-center rounded-full px-0.5"
        style={{ backgroundColor: schedule.active ? color.sage : color.overlay }}
      >
        <View
          className="h-6 w-6 rounded-full"
          style={{ backgroundColor: color.bone, alignSelf: schedule.active ? "flex-end" : "flex-start" }}
        />
      </Pressable>
    </Pressable>
  );
}

function Empty() {
  return (
    <View className="px-5 py-10">
      <Text className="font-sans text-mute" style={{ fontSize: size.body }}>
        Nothing on a clock yet. Schedules are made on the desktop — writing a prompt for an agent
        that cannot ask you a follow-up question wants a keyboard.
      </Text>
    </View>
  );
}
