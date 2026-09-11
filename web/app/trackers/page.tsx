"use client";

/**
 * Where work is read from.
 *
 * GitHub is here without connecting anything: its tracker credential is the
 * git token from Repositories, so the row says where that happens rather than
 * offering a second sign-in that would store the same secret twice.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Card, List, PageHead, Row } from "@/components/ui";
import { ConnectTracker } from "@/components/ConnectTracker";
import {
  getListTrackersQueryKey,
  useDisconnectTracker,
  useListTrackers,
} from "@/src/api/generated/trackers/trackers";
import type { TrackerStatus } from "@/src/api/generated/model";

export default function Trackers() {
  const { data: trackers = [], isLoading } = useListTrackers();
  const [connecting, setConnecting] = useState<TrackerStatus | null>(null);
  const client = useQueryClient();

  const disconnect = useDisconnectTracker({
    mutation: {
      onSuccess: () => client.invalidateQueries({ queryKey: getListTrackersQueryKey() }),
    },
  });

  const connected = trackers.filter((t) => t.connected).length;

  return (
    <div className="px-4 pt-5 pb-24 md:px-8 md:pt-6">
      <PageHead
        eyebrow="Trackers"
        title={isLoading ? "Looking…" : `${connected} of ${trackers.length} connected.`}
      >
        Where the Tasks screen reads from. Each key is yours, and kept encrypted.
      </PageHead>

      <Card>
        <List flush>
          {trackers.map((tracker) => (
            <Row key={tracker.id}>
              <div className="min-w-0 flex-1 py-2.5">
                <p className="text-title text-bone">{tracker.label}</p>
                <p className="mt-0.5 text-meta text-mute">
                  {tracker.auth === "gitProvider"
                    ? "Connected with the git host, under Repositories."
                    : tracker.connected
                      ? "Connected with a personal API key."
                      : "Connects with a personal API key."}
                </p>
              </div>

              <span
                className={`shrink-0 font-mono text-meta ${
                  tracker.connected ? "text-sage" : "text-mute"
                }`}
              >
                {tracker.connected ? "Connected" : "Not connected"}
              </span>

              <div className="ml-3 shrink-0">
                {tracker.auth === "apiKey" &&
                  (tracker.connected ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate({ id: tracker.id })}
                    >
                      Disconnect
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setConnecting(tracker)}>
                      Connect
                    </Button>
                  ))}
              </div>
            </Row>
          ))}
        </List>
      </Card>

      {connecting && (
        <ConnectTracker tracker={connecting} onClose={() => setConnecting(null)} />
      )}
    </div>
  );
}
