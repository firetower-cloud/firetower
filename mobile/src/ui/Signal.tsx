/**
 * One dot, and the only loud colour in the system.
 *
 * Ember answers one question — is something blocked on you — and it stops
 * answering it the moment it answers anything else. The tone is derived from
 * `BEAT` rather than written out, for the reason the desktop file gives: being
 * right separately from everything else is how two surfaces come to paint the
 * same session two colours.
 */
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { SessionStatus } from "~/api/generated/model";
import { BEAT, BEAT_TOKEN } from "~/api/view";
import { color } from "~/design/tokens.generated";

export function Signal({ status, size = 9 }: { status: SessionStatus; size?: number }) {
  const tone = color[BEAT_TOKEN[BEAT[status]]];
  const hollow = status === "Ended" || status === "Starting" || status === "Ready";

  return (
    <View
      style={{ width: size * 2.2, height: size * 2.2, alignItems: "center", justifyContent: "center" }}
    >
      {status === "Failed" ? (
        <Svg width={size + 3} height={size + 3} viewBox="0 0 10 10">
          <Path d="M2 2l6 6M8 2l-6 6" stroke={tone} strokeWidth={1.6} strokeLinecap="round" />
        </Svg>
      ) : status === "HandedBack" ? (
        <Svg width={size + 4} height={size + 4} viewBox="0 0 11 11">
          <Path
            d="M1.5 5.8l2.6 2.6L9.5 3"
            stroke={tone}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      ) : (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size,
            backgroundColor: hollow ? "transparent" : tone,
            borderWidth: hollow ? 1 : 0,
            borderColor: tone,
          }}
        />
      )}
    </View>
  );
}
