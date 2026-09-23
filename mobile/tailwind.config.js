/** Every value here comes from web/app/globals.css through scripts/tokens.mjs.
    Nothing is written twice; see src/design/tokens.generated.js. */
const tokens = require("./src/design/tokens.generated.js");

module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: tokens.colors,
      fontSize: tokens.fontSize,
      borderRadius: tokens.radius,
      fontFamily: tokens.fonts,
      spacing: tokens.spacing,
    },
  },
  plugins: [],
};
