import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
p.on('console', (m) => console.log('[c]', m.text().slice(0, 400)));
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5441/_worldtest/index.html');
await p.waitForFunction('window.ready||window.err', null, { timeout: 120000 });
console.log(await p.evaluate(process.argv[2]));
await b.close();
