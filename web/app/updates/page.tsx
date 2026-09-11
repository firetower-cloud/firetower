"use client";

import { UpdatesScreen } from "@/components/Updates";

/**
 * Whether a release is out, and moving to it.
 *
 * A page of its own rather than a section of Configuration: it is the one
 * screen that acts on every machine at once, and the rail has to be able to
 * say "there is something here" from anywhere.
 */
export default function Updates() {
  return <UpdatesScreen />;
}
