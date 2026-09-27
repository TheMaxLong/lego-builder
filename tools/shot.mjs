// Screenshot the browser build of the app for visual checks.
// Usage: node tools/shot.mjs <out.png> [js-to-run-after-ready] [waitMs]
// Needs tools/devserver.mjs running on :5173. Uses the Playwright copy that ships with the playwright skill.
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
const pw = require(os.homedir() + '/.claude/plugins/cache/playwright-skill/playwright-skill/4.1.0/skills/playwright-skill/node_modules/playwright');

const [out, script = '', wait = '1500'] = process.argv.slice(2);
const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://127.0.0.1:5173/');
try {
  await page.waitForFunction('window.appReady === true', null, { timeout: 120000 });
} catch {
  logs.push('[shot] app never became ready');
}
if (script) {
  try {
    const r = await page.evaluate(`(async () => { ${script} })()`);
    if (r !== undefined) console.log('result:', JSON.stringify(r));
  } catch (e) {
    logs.push('[script error] ' + e.message);
  }
}
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
console.log(logs.filter(l => !l.includes('GPU stall')).slice(0, 40).join('\n'));
await browser.close();
