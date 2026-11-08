/** Every value here comes from the four sheets scripts/tokens.mjs declares.
    Nothing is written twice; see src/design/tailwind.generated.js.

    `colors` are `var()` references rather than literals, and `tokens.base`
    declares those variables for light with a `prefers-color-scheme` override
    for dark. That is the whole theming mechanism: 280 class names across
    `app/` and `src/` follow the theme without one of them carrying a `dark:`.

    `darkMode: "class"` so the handful of places that genuinely need a
    `dark:` variant — a shadow, which inverts rather than re-colours — follow
    NativeWind's own colour-scheme state and therefore the same control on
    the You tab as everything else. */
const tokens = require("./src/design/tailwind.generated.js");

module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      colors: tokens.colors,
      fontSize: tokens.fontSize,
      borderRadius: tokens.radius,
      fontFamily: tokens.fonts,
      spacing: tokens.spacing,
    },
  },
  plugins: [({ addBase }) => addBase(tokens.base)],
};
