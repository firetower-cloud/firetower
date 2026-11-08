/**
 * What a file *is*, as one of seven categories.
 *
 * A separate namespace from the signals and deliberately below them in
 * saturation: a panel of four hundred rows must not be able to out-shout the
 * one thing on screen that means an agent is waiting on you. Seven categories,
 * not ninety formats.
 *
 * `kindOf` is the whole of the logic and it is a pure function of a path, so
 * it stays a plain export. The *tone* is theme-dependent, so it is a hook —
 * the map used to be a module-scope constant, which froze whichever branch
 * happened to be loaded first into every file tree in the app.
 */
import { useTheme } from "~/design/theme";

export type Kind = "source" | "native" | "data" | "style" | "media" | "store" | "prose";

export function kindOf(path: string): Kind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["rs", "go", "c", "h", "cpp", "swift", "kt"].includes(ext)) return "native";
  if (["ts", "tsx", "js", "jsx", "py", "rb", "java"].includes(ext)) return "source";
  if (["json", "toml", "yaml", "yml", "lock"].includes(ext)) return "data";
  if (["css", "scss", "mk"].includes(ext)) return "style";
  if (["png", "jpg", "jpeg", "svg", "gif", "webp"].includes(ext)) return "media";
  if (["sql", "db", "sqlite"].includes(ext)) return "store";
  return "prose";
}

/** The tone for a path, in the theme being drawn. */
export function useToneOf(): (path: string) => string {
  const { color } = useTheme();
  return (path: string) => color[`kind-${kindOf(path)}`];
}
