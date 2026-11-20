// Builds the single Windows app:  release/<exeName>.exe
//   1. bundle the Node server and make it a standalone exe (Node single-executable application)
//   2. embed that server inside the desktop host (WebView2 window + read-only screen capture)
// Needs Node 22+ and the .NET 8 SDK. Same script in both repos; app details come from package.json "app".
import { build } from 'esbuild';
import { inject } from 'postject';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const exeName = pkg.exeName;
const out = resolve(root, 'build');
const rel = resolve(root, 'release');
rmSync(out, { recursive: true, force: true });
rmSync(rel, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(rel, { recursive: true });

console.log('1/4 bundling server…');
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: resolve(out, 'app.cjs'),
  define: { __PACKAGED__: 'true', __VERSION__: JSON.stringify(pkg.version), 'import.meta.dirname': '""' },
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});

console.log('2/4 making the server exe…');
const assets = {};
for (const f of readdirSync(resolve(root, 'public'))) assets[f] = resolve(root, 'public', f);
const seaConfig = resolve(out, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({
  main: resolve(out, 'app.cjs'), output: resolve(out, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
const serverExe = resolve(out, 'server.exe');
copyFileSync(process.execPath, serverExe);
await inject(serverExe, 'NODE_SEA_BLOB', readFileSync(resolve(out, 'sea-prep.blob')), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });

console.log('3/4 building the desktop app…');
const appInfo = resolve(out, 'appinfo.json');
writeFileSync(appInfo, JSON.stringify(pkg.app, null, 2));
execFileSync('dotnet', [
  'publish', resolve(root, 'host/LovenseLinkHost.csproj'), '-c', 'Release', '-nologo', '-v', 'q',
  '-o', resolve(out, 'host'), `-p:ServerExe=${serverExe}`, `-p:AppInfo=${appInfo}`, `-p:AssemblyName=${exeName}`,
  `-p:Version=${pkg.version}`, `-p:Product=${pkg.app.title}`,
], { stdio: 'inherit' });

console.log('4/4 done');
copyFileSync(resolve(out, 'host', `${exeName}.exe`), resolve(rel, `${exeName}.exe`));
console.log(`  ${resolve(rel, `${exeName}.exe`)}`);
