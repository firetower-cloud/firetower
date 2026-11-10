# Brand assets

The README and app icons use the approved monochrome tower. The default icon is black on white; the mobile dark appearance reverses it. Operational status indicators remain separate from the brand.

## Sources and generated files

- `desktop/src-tauri/icons-src/app-icon.svg` is the icon master. Its 1024 × 1024 canvas has a full white background for the default mobile icon.
- `desktop/scripts/generate-brand-assets.mjs` renders that master with platform-specific padding and appearance colors. It generates the desktop PNG, ICNS and ICO files, Windows tray states, mobile icons and splash images.
- `.github/assets/header-light.svg` and `header-dark.svg` are the README header sources. They embed DM Sans so rendering is independent of installed fonts. Its license is beside them.
- `.github/assets/agent-team-{light,dark}.webp` show actual desktop components with sample API data: a lead conversation and five child workspaces. They are illustrative screenshots, not evidence of a completed production task.
- `.github/assets/architecture.svg` explains the client, control-plane and worker relationship.

To regenerate icons and header PNGs, install desktop dependencies and Chrome, then run from the repository root:

```sh
pnpm --dir desktop install --frozen-lockfile
node desktop/scripts/generate-brand-assets.mjs
```

Alternatively, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to a Chromium binary. The script uses the project's Tauri CLI for native icon bundles. It does not rebuild the conversation screenshots.

## Platform handling

macOS uses an inset rounded white tile in the existing ICNS bundle. Windows uses the same mark in ICO and PNG sizes. The waiting tray icon keeps its orange notification badge; the taskbar's existing overlay badge is unchanged.

iOS gets opaque square light, dark and tinted images through `ios.icon`. The OS applies the mask. Android uses a transparent foreground on a white background, with a separate monochrome layer. The foreground is inset to protect the tower under adaptive masks. Light and dark splash screens use their own transparent marks and retain the app's existing page colors.

The DMG background has no old logo and remains unchanged. Its mounted-volume icon comes from the regenerated ICNS.

## Validate a change

Run the repository checks in `AGENTS.md`. Inspect the icons at small sizes, then check Expo's native output:

```sh
cd mobile
pnpm exec expo config --type prebuild
pnpm exec expo prebuild --no-install --platform all
```

The generated `ios/` and `android/` directories are ignored. Verify all three iOS appearances in the asset catalog, Android's foreground/monochrome references, and both splash variants. Use a native preview or release build to check the installed icon and splash; Expo Go is not a reliable preview of these resources.

README documentation links target the redesigned website introduced in `firetower-cloud/firetower-website#14`. Verify that deployment when publishing the README update.
