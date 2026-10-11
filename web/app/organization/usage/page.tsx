import { Consumption } from "@/components/org/Consumption";

/**
 * "Usage" to whoever reads it; `consumption` underneath.
 *
 * Not the same word on both sides on purpose: `WorkspaceUsage` already means
 * the cores and megabytes a workspace is taking, and a second `Usage` in the
 * code would be two unrelated things with one name. The label is for people and
 * the identifier is for the next person reading `ft-server`.
 */
export default function UsagePage() {
  return <Consumption />;
}
