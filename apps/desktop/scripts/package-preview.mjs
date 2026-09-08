// Package a source-built macOS app as a valid ad-hoc, unnotarized preview.
// Does not remove quarantine or change Gatekeeper settings.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, readFile, writeFile, mkdtemp, symlink, mkdir, lstat, readdir, open } from 'node:fs/promises';
import { join, resolve, dirname, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const [input, sourceCommit] = process.argv.slice(2);
if (!input || !sourceCommit) throw new Error('Usage: node scripts/package-preview.mjs <built.app> <source-commit>');
const require = createRequire(new URL('../package.json', import.meta.url));
const { signAsync } = require('@electron/osx-sign');
const { extractFile } = require('@electron/asar');
const original = resolve(input);
const pkg = JSON.parse(extractFile(join(original, 'Contents/Resources/app.asar'), 'package.json').toString());
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid preview version');

// Follow physical files only, not pnpm's cyclic dependency symlink graph.
const signerUtil = require(join(dirname(require.resolve('@electron/osx-sign')), 'util.js'));
signerUtil.walkAsync = async function walkPhysical(dir) {
  const paths = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      paths.push(...await walkPhysical(path));
      if (['.app', '.framework'].includes(extname(path))) paths.push(path);
    } else if (stat.isFile()) {
      const handle = await open(path, 'r');
      const magic = Buffer.alloc(4);
      try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
      if (['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic.toString('hex')) &&
          execFileSync('/usr/bin/file', ['-b', path], {encoding:'utf8'}).includes('Mach-O')) paths.push(path);
    }
  }
  return paths;
};
const work = await mkdtemp('/private/tmp/clawrouter-preview-release-');
console.log(`RELEASE_DIR=${work}`);
const stage = join(work, 'stage');
await mkdir(stage);
const app = join(stage, 'ClawRouter.app');
await cp(original, app, {recursive:true, force:false, errorOnExist:true, verbatimSymlinks:true});
for (const attr of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
  try { execFileSync('/usr/bin/xattr', ['-dr', attr, app], {stdio:'pipe'}); } catch {}
}
await signAsync({app, platform:'darwin', identity:'-', identityValidation:false,
  preAutoEntitlements:false, preEmbedProvisioningProfile:false, strictVerify:true,
  optionsForFile:()=>({hardenedRuntime:true, timestamp:'none', entitlements:[
    'com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation'
  ]})});
console.log('AD_HOC_SIGNING_COMPLETE');
await symlink('/Applications', join(stage, 'Applications'));
const dmg = join(work, `ClawRouter-${version}-arm64.dmg`);
execFileSync('/usr/bin/hdiutil', ['create', '-volname', `ClawRouter ${version}-arm64`, '-srcfolder', stage,
  '-format', 'UDZO', '-fs', 'HFS+', '-imagekey', 'zlib-level=9', dmg], {stdio:'inherit'});
const zip = join(work, `ClawRouter-${version}-arm64-mac.zip`);
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
const sha = b => createHash('sha256').update(b).digest('hex');
await writeFile(join(work, 'SHA256SUMS.txt'), (await Promise.all([dmg, zip].map(async p => `${sha(await readFile(p))}  ${p.split('/').pop()}`))).join('\n')+'\n');
await writeFile(join(work, 'BUILD-PROVENANCE.json'), JSON.stringify({version, sourceCommit,
  type:'source-built-desktop-preview', runtime:'0.12.278', signature:'ad-hoc', notarized:false,
  quarantineRemoved:false, finalInstallationRetested:false,
  signerVersion:require('@electron/osx-sign/package.json').version,
  appAsarSha256:sha(await readFile(join(app, 'Contents/Resources/app.asar')))
}, null, 2)+'\n');
console.log(`PACKAGING_COMPLETE=${work}`);
