/** Regenerate the approved README and app assets. Run from any directory:
 * node desktop/scripts/generate-brand-assets.mjs
 * Requires desktop dependencies and Chrome (or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH).
 * Native icon bundles are generated with the project's Tauri CLI.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = path.join(root, 'desktop');
const master = await fs.readFile(path.join(desktop, 'src-tauri/icons-src/app-icon.svg'), 'utf8');
const background = '<rect width="1024" height="1024" fill="#ffffff"/>';
const inner = master.replace(/<svg[^>]*>/, '').replace('</svg>', '');
const wrap = body => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>`;
const foreground = master.replace(background, '');
const android = foreground.replace('translate(230.4 160) scale(8.8)', 'translate(286.72 230.4) scale(7.04)');
const desktopTile = wrap(`<g transform="translate(64 64) scale(.875)">${inner.replace(background, '<rect width="1024" height="1024" rx="230" fill="#ffffff"/>')}</g>`);
// Keep the native tile footprint, but give the macOS tower less inner padding.
// Other platforms retain their existing composition and safe areas.
const mac = desktopTile.replace('translate(230.4 160) scale(8.8)', 'translate(166.4 80) scale(10.8)');
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true }
  : { channel: 'chrome', headless: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'firetower-brand-'));
try {
  async function png(svg, output, width = 1024, height = width) {
    // A fresh page prevents stale compositor tiles when output sizes change.
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent('<style>html,body{margin:0;width:100%;height:100%;background:transparent}img{display:block;width:100%;height:100%}</style><img alt="" src="data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') + '">');
    await page.locator('img').evaluate(img => img.decode());
    await page.screenshot({ path: output, omitBackground: true });
    await page.close();
  }
  async function generateMacIcon() {
    // Only the macOS bundle and DMG volume use this enlarged composition.
    await png(mac, path.join(temp, 'mac.png'));
    execFileSync('pnpm', ['exec', 'tauri', 'icon', path.join(temp, 'mac.png'), '-o', path.join(temp, 'mac-icons')], { cwd: desktop, stdio: 'pipe' });
    await fs.copyFile(path.join(temp, 'mac-icons/icon.icns'), path.join(desktop, 'src-tauri/icons/icon.icns'));
  }
  if (process.argv.includes('--mac-only')) {
    await generateMacIcon();
    console.log('Generated the macOS ICNS bundle.');
  } else {
    await png(desktopTile, path.join(temp, 'desktop.png'));
    // Tauri also generates mobile bundles; copy only desktop outputs, since
    // Expo owns the native mobile assets and uses different padding/masks.
    execFileSync('pnpm', ['exec', 'tauri', 'icon', path.join(temp, 'desktop.png'), '-o', path.join(temp, 'icons')], { cwd: desktop, stdio: 'pipe' });
    for (const file of await fs.readdir(path.join(temp, 'icons'))) {
      if (/\.(png|ico|icns)$/.test(file)) await fs.copyFile(path.join(temp, 'icons', file), path.join(desktop, 'src-tauri/icons', file));
    }
    await png(desktopTile, path.join(desktop, 'src-tauri/icons/64x64.png'), 64);
    await generateMacIcon();
    // Windows tray icons retain the existing waiting signal, separate from
    // the monochrome brand. The overlay badge itself stays unchanged.
    const tray = wrap(`<rect x="40" y="40" width="944" height="944" rx="220" fill="#ffffff"/>${inner.replace(background, '')}`);
    await png(tray, path.join(desktop, 'src-tauri/icons/tray-idle.png'), 32);
    await png(tray.replace('</svg>', '<circle cx="800" cy="800" r="170" fill="#ff6b2c" stroke="#ffffff" stroke-width="50"/></svg>'), path.join(desktop, 'src-tauri/icons/tray-waiting.png'), 32);
    const mobileAssets = {
      'icon.png': master,
      'icon-dark.png': master.replace('#ffffff', '#161615').replace('#111110', '#f8f8f7'),
      'icon-tinted.png': master.replace('#ffffff', '#000000').replace('#111110', '#ffffff'),
      'android-icon-foreground.png': android,
      'android-icon-monochrome.png': android.replace('#111110', '#000000'),
      'android-icon-background.png': wrap(background),
      'splash-icon.png': foreground,
      'splash-icon-dark.png': foreground.replace('#111110', '#f8f8f7'),
    };
    for (const [file, svg] of Object.entries(mobileAssets)) await png(svg, path.join(root, 'mobile/assets', file));
    await png(master, path.join(root, 'mobile/assets/favicon.png'), 48);
    for (const theme of ['light', 'dark']) {
      const svg = await fs.readFile(path.join(root, `.github/assets/header-${theme}.svg`), 'utf8');
      await png(svg, path.join(root, `.github/assets/header-${theme}.png`), 1280, 500);
    }
    console.log('Generated desktop icons, mobile appearances, launch artwork and README headers.');
  }
} finally {
  await browser.close();
  await fs.rm(temp, { recursive: true, force: true });
}
