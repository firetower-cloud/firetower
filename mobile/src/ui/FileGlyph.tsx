/**
 * What a file *is*, as one of nine categories.
 *
 * A separate namespace from the signals and deliberately below them in
 * saturation: a panel of four hundred rows must not be able to out-shout the
 * one thing on screen that means an agent is waiting on you. Nine categories,
 * not ninety formats.
 */
import { color } from "~/design/tokens.generated";

export function kindOf(path: string): keyof typeof TONE {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["rs", "go", "c", "h", "cpp", "swift", "kt"].includes(ext)) return "native";
  if (["ts", "tsx", "js", "jsx", "py", "rb", "java"].includes(ext)) return "source";
  if (["json", "toml", "yaml", "yml", "lock"].includes(ext)) return "data";
  if (["css", "scss", "mk"].includes(ext)) return "style";
  if (["png", "jpg", "jpeg", "svg", "gif", "webp"].includes(ext)) return "media";
  if (["sql", "db", "sqlite"].includes(ext)) return "store";
  return "prose";
}

const TONE = {
  source: color["kind-source"],
  native: color["kind-native"],
  data: color["kind-data"],
  style: color["kind-style"],
  media: color["kind-media"],
  store: color["kind-store"],
  prose: color["kind-prose"],
} as const;

export const toneOf = (path: string) => TONE[kindOf(path)];
