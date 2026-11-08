/* Generated from the four sources in scripts/tokens.mjs — do not edit.
   Run `just gen` (or `pnpm tokens`) after changing a token in any of them.

   Both branches, resolved. Do not import `light` or `dark` directly from a
   component — `src/design/theme.tsx` picks between them for the active theme
   and a component that reaches past it is a component that does not follow
   the theme. `Palette` is the type of either. */
export const light = {
  "amber": "#653400",
  "amber-deep": "#b79045",
  "amber-soft": "#a8780f",
  "amber-tint": "#fcebce",
  "bone": "#161617",
  "brick": "#b83a30",
  "brick-deep": "#f7a9a0",
  "brick-tint": "#fff3f2",
  "dim": "#7b7b83",
  "ember": "#ff5e1a",
  "ember-deep": "#eaa078",
  "ember-ink": "#bf4714",
  "ember-soft": "#ff7a36",
  "ember-tint": "#fff0e8",
  "float": "#ffffff",
  "ground": "#ffffff",
  "host-gitea": "#609926",
  "host-github": "#1b1f23",
  "host-gitlab": "#e24329",
  "kind-data": "#776520",
  "kind-media": "#37714d",
  "kind-native": "#8b5b39",
  "kind-prose": "#65666f",
  "kind-source": "#4f688a",
  "kind-store": "#925178",
  "kind-style": "#6b5f93",
  "line": "#e5e5ea",
  "line-soft": "#efeff2",
  "mute": "#a6a6af",
  "overlay": "#e8e8ec",
  "panel": "#fafafb",
  "raise": "#f6f6f9",
  "sage": "#2f7d52",
  "sage-deep": "#a9d6bb",
  "sage-tint": "#eaf6ee",
  "scrim": "rgb(22 22 23 / 0.34)",
  "series-1": "#2575bd",
  "series-2": "#00825d",
  "series-3": "#7465c1",
  "series-4": "#ba4b76",
  "settling": "#cbcbd1",
  "slate": "#44607e",
  "slate-deep": "#afc0d2",
  "slate-tint": "#edf1f6",
  "syn-attr": "#676771",
  "syn-comment": "#878792",
  "syn-fn": "#895a37",
  "syn-keyword": "#65598e",
  "syn-number": "#5a4c14",
  "syn-string": "#2d5439",
  "syn-type": "#4c647d",
  "text": "#47474d"
} as const;

export const dark = {
  "amber": "#fab219",
  "amber-deep": "#7a5a0d",
  "amber-soft": "#fab219",
  "amber-tint": "#2a2008",
  "bone": "#eaeaeb",
  "brick": "#e5645a",
  "brick-deep": "#6e2f2b",
  "brick-tint": "#2a1414",
  "dim": "#8b8b93",
  "ember": "#ff6b2c",
  "ember-deep": "#7a3417",
  "ember-ink": "#ff9a6b",
  "ember-soft": "#ff9a6b",
  "ember-tint": "#2a1509",
  "float": "#1e1e22",
  "ground": "#0b0b0c",
  "host-gitea": "#609926",
  "host-github": "#f4f4f5",
  "host-gitlab": "#fc6d26",
  "kind-data": "#c2ab63",
  "kind-media": "#79b58d",
  "kind-native": "#b8845f",
  "kind-prose": "#9a9aa4",
  "kind-source": "#7b93b8",
  "kind-store": "#bd79a1",
  "kind-style": "#9a8cc4",
  "line": "#26262b",
  "line-soft": "#1a1a1e",
  "mute": "#5e5e67",
  "overlay": "#1e1e22",
  "panel": "#111113",
  "raise": "#17171a",
  "sage": "#6ec08a",
  "sage-deep": "#2c5b3d",
  "sage-tint": "#12251a",
  "scrim": "rgb(0 0 0 / 0.45)",
  "series-1": "#3f86cf",
  "series-2": "#1f9b74",
  "series-3": "#8b7ad8",
  "series-4": "#cc5c86",
  "settling": "#3e3e46",
  "slate": "#7d95b0",
  "slate-deep": "#35485c",
  "slate-tint": "#161d26",
  "syn-attr": "#8a8a94",
  "syn-comment": "#6a6a74",
  "syn-fn": "#b8845f",
  "syn-keyword": "#9a8cc4",
  "syn-number": "#c2ab63",
  "syn-string": "#8fb99a",
  "syn-type": "#7d95b0",
  "text": "#b9b9bf"
} as const;

/* Widened on purpose. `as const` on each branch is worth keeping — it is
   what makes `color.` autocomplete and what catches a misspelt token at
   build time — but it also makes the two branches two *different* literal
   types, neither assignable to the other. A palette is a map of the same
   names to colours, and that is what a component is handed. */
export type Palette = { readonly [K in keyof typeof light]: string };

export const size = {
  "figure": 64,
  "display": 28,
  "title": 18,
  "body": 16,
  "ui": 15,
  "meta": 13,
  "micro": 12,
  "code": 15,
  "read": 17
} as const;

export const radius = {
  "xs": 4,
  "sm": 6,
  "md": 8,
  "lg": 12,
  "DEFAULT": 8
} as const;

export const shadow = { light: {
  "raise": "0 2px 6px rgb(22 22 23 / 0.06), 0 0 0 1px rgb(22 22 23 / 0.04)",
  "float": "0 18px 44px -18px rgb(22 22 23 / 0.26), 0 2px 8px rgb(22 22 23 / 0.05)"
}, dark: {
  "raise": "inset 0 1px 0 rgb(255 255 255 / 0.04), 0 1px 2px rgb(0 0 0 / 0.4)",
  "float": "inset 0 1px 0 rgb(255 255 255 / 0.05), 0 16px 40px -16px rgb(0 0 0 / 0.7)"
} } as const;
