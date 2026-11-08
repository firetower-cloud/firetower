/**
 * The theme, as the app reads it.
 *
 * Two halves, and the split is what makes the whole thing work:
 *
 * - **Class names need nothing.** `bg-ground`, `text-bone` and the other 280
 *   of them resolve to `var(--ft-…)`, and `tokens.base` declares those
 *   variables for light with a `prefers-color-scheme` override for dark. So
 *   setting NativeWind's colour scheme re-draws every one of them and not a
 *   single component mentions a theme.
 * - **Imperative colours need this.** A Lucide icon takes a `color` prop, a
 *   Reanimated worklet takes a value, an SVG takes a fill, the status bar
 *   takes a style. Those cannot read a CSS variable, so they read `useTheme()`
 *   — which returns the same palette the classes resolved to, from the same
 *   generated file.
 *
 * The call sites are deliberately unchanged in shape: a screen that said
 * `import { color } from "~/design/tokens.generated"` now says
 * `const { color } = useTheme()`, and every `color.bone` below it is
 * byte-identical. That is the only reason a 196-call-site change was worth
 * making in one pass.
 *
 * **Nothing imports `light` or `dark` from `tokens.generated` directly.** A
 * component that reaches past this is a component that does not follow the
 * theme, and it will look right in whichever branch its author was in.
 *
 * The pure half is `scheme.ts` — the `Choice` type, the three settings and
 * `resolve`, which is all of the logic and all of what a test can get at. It
 * is a separate basename rather than `theme.ts` because every resolver that
 * puts `.ts` before `.tsx` hands `import … from "~/design/theme"` the file
 * with no `useTheme` in it, and the error that produces names the import
 * rather than the cause.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { colorScheme, useColorScheme } from "nativewind";
import { dark, light, type Palette } from "~/design/tokens.generated";
import { CHOICES, readChoice, resolve, writeChoice, type Choice, type Scheme } from "~/design/scheme";

export { CHOICES, type Choice, type Scheme };

type Theme = {
  /** The resolved palette. `color.bone` reads the same as it always did. */
  color: Palette;
  /** What is being drawn. */
  scheme: Scheme;
  /** What the person chose, which is a different question. */
  choice: Choice;
  choose: (next: Choice) => void;
};

const PALETTE: Record<Scheme, Palette> = { light, dark };

/* The default is what a component outside the provider would get, and the
   honest value is the design's own default rather than a throw: a theme is not
   something a screen can be broken by not having. */
const Ctx = createContext<Theme>({
  color: light,
  scheme: "light",
  choice: "system",
  choose: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  /* Read synchronously, before the first paint. A promise here is one frame
     of the wrong theme, which on this palette is a white flash on a phone
     somebody set to dark. */
  const [choice, setChoice] = useState<Choice>(readChoice);

  /**
   * `colorScheme.set` is what actually moves the class names.
   *
   * NativeWind owns the colour scheme the compiled `prefers-color-scheme`
   * rules are evaluated against, so this is the one call that re-draws the
   * sheet. `"system"` hands it back to the OS, which is why the three-way
   * choice maps onto it exactly rather than being resolved here first.
   *
   * In an effect rather than during render because it is a store write, and
   * on mount as well as on change — the stored choice has to be applied to a
   * freshly launched process, which is the half that makes it survive a
   * restart rather than merely being remembered.
   */
  useEffect(() => {
    colorScheme.set(choice);
  }, [choice]);

  /* What the OS says, after NativeWind has resolved `system` against it. */
  const { colorScheme: active } = useColorScheme();
  const scheme = resolve(choice, active as Scheme | null | undefined);

  const choose = useCallback((next: Choice) => {
    writeChoice(next);
    setChoice(next);
  }, []);

  const value = useMemo<Theme>(
    () => ({ color: PALETTE[scheme], scheme, choice, choose }),
    [scheme, choice, choose],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
