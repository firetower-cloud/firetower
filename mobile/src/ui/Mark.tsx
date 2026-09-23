/** The lookout tower: legs, cabin, and the light that's lit. */
import Svg, { Circle, Path } from "react-native-svg";
import { color } from "~/design/tokens.generated";

export function Mark({ size = 20, tone = color.bone }: { size?: number; tone?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path d="M4.4 19L7 9.6M15.6 19L13 9.6" stroke={tone} strokeWidth={1.3} strokeLinecap="round" />
      <Path d="M6.1 14.4h7.8" stroke={tone} strokeWidth={1.1} strokeLinecap="round" opacity={0.55} />
      <Path d="M6.4 9.4h7.2v-3H6.4z" stroke={tone} strokeWidth={1.3} strokeLinejoin="round" fill="none" />
      <Path d="M4.8 6.4L10 2.2l5.2 4.2" stroke={tone} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Circle cx={10} cy={7.9} r={1.15} fill={color.ember} />
    </Svg>
  );
}
