/**
 * Renders the dashboard and saves pictures of it.
 *
 * The machine this is developed on has no screen and sits behind a tunnel, so
 * the interface cannot simply be opened and looked at. This produces images
 * that can be reviewed anywhere, and lets the layout be checked rather than
 * assumed: a validator can say a colour is legible, but only a picture shows a
 * label colliding with an axis.
 *
 * Signs in first, because every page worth photographing is behind a session
 * and an unauthenticated run would produce four copies of the login form.
 * Credentials come from the environment so none ends up in the repository:
 *
 *   MCPSPAN_SCREENSHOT_EMAIL=... MCPSPAN_SCREENSHOT_PASSWORD=... \
 *     pnpm --filter @mcpspan/core-dashboard screenshot [baseUrl] [outDir]
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const [baseUrl = 'http://127.0.0.1:6270', outDir = 'screenshots'] = process.argv.slice(2);

/** Every screen worth a picture, named as the file will be. */
const PAGES = [
  { name: 'overview', path: '/' },
  { name: 'errors', path: '/errors' },
  // Named after the tool the local end-to-end server registers.
  { name: 'tool', path: '/tool?toolName=search_flights' },
  { name: 'sessions', path: '/sessions' },
  { name: 'status', path: '/status' },
  { name: 'settings', path: '/settings' },
  { name: 'login', path: '/login' },
];

/**
 * Light only, matching the interface. The dark steps exist but nothing turns
 * them on yet, so shooting a dark variant would only photograph the light one
 * twice.
 */
const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();

const email = process.env['MCPSPAN_SCREENSHOT_EMAIL'];
const password = process.env['MCPSPAN_SCREENSHOT_PASSWORD'];

try {
  for (const target of PAGES) {
    for (const view of VIEWS) {
      const context = await browser.newContext({
        viewport: { width: view.width, height: view.height },
        colorScheme: 'light',
        deviceScaleFactor: 2,
      });

      // Through the app's own proxy, so the session cookie is set for this
      // origin exactly as a browser would have it after signing in.
      if (email !== undefined && password !== undefined && target.path !== '/login') {
        await context.request.post(`${baseUrl}/api/auth/login`, {
          data: { email, password },
        });
      }

      const page = await context.newPage();

      await page.goto(`${baseUrl}${target.path}`, { waitUntil: 'networkidle' });
      // The chart measures its container before drawing, so a shot taken the
      // instant the page settles catches an empty box.
      await page.waitForTimeout(500);

      const file = `${outDir}/${target.name}-${view.name}.png`;
      await page.screenshot({ path: file, fullPage: true });
      await page.close();
      await context.close();

      console.log(file);
    }
  }
} finally {
  await browser.close();
}
