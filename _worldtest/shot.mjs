import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
const jobs = JSON.parse(process.argv[2]);
const out = process.argv[3] || '/tmp/claude-0/-home-user-rts-game/b477b8f7-3dc3-554c-8a11-1ce7a11b48fa/scratchpad';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1000, height: 640 } });
p.on('console', (m) => { if (m.type() === 'error' || m.type()==='warning') console.log('[console]', m.text().slice(0, 300)); });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto('http://localhost:5441/_worldtest/index.html');
await p.waitForFunction('window.ready||window.err', null, { timeout: 120000 });
console.log('err', await p.evaluate('window.err'), 'tCities', await p.evaluate('window.tCities'), 'tDetail', await p.evaluate('window.tDetail'), 'bld', await p.evaluate('window.cities.buildingCount'));
for (const j of jobs) {
  await p.evaluate(`(${j.js})()`);
  let ms = 0;
  for (let k = 0; k < (j.warm ?? 6); k++) ms = await p.evaluate('window.frames(' + (j.nf ?? 3) + ')');
  console.log(j.name, 'ms/frame', ms.toFixed(0), JSON.stringify(await p.evaluate('window.info()')));
  await p.screenshot({ path: `${out}/${j.name}.png`, timeout: 180000 });
}
await b.close();
