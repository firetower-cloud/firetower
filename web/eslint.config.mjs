import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The type scale and the palette are the design system. A size or a colour
    // written at the point of use is how the last one ended up with 21 font
    // sizes and 13 radii — each one defensible, none of them agreeing.
    files: ["app/**/*.tsx", "components/**/*.tsx", "src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/(text|rounded)-\\[[0-9]/]",
          message:
            "Use a token: text-display|title|body|ui|meta|micro, rounded-sm|md|lg. See app/globals.css.",
        },
        {
          selector: "JSXAttribute[name.name='className'] Literal[value=/-\\[#[0-9a-fA-F]/]",
          message: "Use a colour token from app/globals.css rather than a hex value.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
