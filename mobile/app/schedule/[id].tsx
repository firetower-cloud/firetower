/**
 * One schedule, pushed.
 *
 * The screen is `~/ui/ScheduleDetail` so the Duo's landscape pose can put the
 * same thing in its right pane rather than a second copy of it — unfolding
 * moves the schedule you had open into the pane, and it has to be the same
 * component or the two drift.
 */
import { useLocalSearchParams } from "expo-router";
import { Detail } from "~/ui/ScheduleDetail";

export default function OneSchedule() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Detail id={id!} />;
}
