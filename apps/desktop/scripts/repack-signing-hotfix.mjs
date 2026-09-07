// Reproduce the 0.1.1 signing-only preview from the immutable public 0.1.0 DMG.
// No business logic is rebuilt or changed. Never clears quarantine.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, readFile, writeFile, mkdtemp, symlink, mkdir, lstat, readdir, open } from 'node:fs/promises';
import { join, resolve, dirname, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const [image, mountedApp, dependencyPackage] = process.argv.slice(2);
if (!image || !mountedApp || !dependencyPackage) throw new Error('Usage: node repack-signing-hotfix.mjs <original.dmg> <mounted/ClawRouter.app> <desktop/package.json with installed build dependencies>');
const require = createRequire(resolve(dependencyPackage));
const { extractAll, createPackage, getRawHeader, extractFile, uncache } = require('@electron/asar');
const { signAsync } = require('@electron/osx-sign');
// osx-sign 1.3.3 follows pnpm symlinks with stat(), traversing the dependency
// graph repeatedly. Walk physical files sequentially instead. This only changes
// discovery; the normal nested-first signing and strict verification are retained.
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
const sha = b => createHash('sha256').update(b).digest('hex');
const inputHash = sha(await readFile(image));
if (inputHash !== '0b687450d3d621fad0da0cb292dfe528aa963199cfeb9842a1a0f97beed9c954') throw new Error('Unrecognized original DMG');
const work = await mkdtemp('/private/tmp/clawrouter-signing-release-');
console.log(`BUILD_DIR=${work}`);
const stage = join(work, 'stage');
await mkdir(stage);
const app = join(stage, 'ClawRouter.app');
await cp(mountedApp, app, {recursive:true, force:false, errorOnExist:true, verbatimSymlinks:true});
const resources = join(app, 'Contents/Resources');
const archive = join(resources, 'app.asar');
const unpacked = join(work, 'asar');
const oldMain = sha(extractFile(archive, 'dist-electron/main.cjs'));
const oldPreload = sha(extractFile(archive, 'dist-electron/preload.cjs'));
extractAll(archive, unpacked);
const pkgPath = join(unpacked, 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
if (pkg.version !== '0.1.0') throw new Error('Unexpected input version');
pkg.version = '0.1.1';
await writeFile(pkgPath, JSON.stringify(pkg, null, 2)+'\n');
await createPackage(unpacked, archive);
uncache(archive); // Old offsets are invalid after changing package.json length.
if (sha(extractFile(archive, 'dist-electron/main.cjs')) !== oldMain || sha(extractFile(archive, 'dist-electron/preload.cjs')) !== oldPreload) throw new Error('Application logic changed');
const plist = join(app, 'Contents/Info.plist');
for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} 0.1.1`, plist]);
const asarHash = sha(getRawHeader(archive).headerString);
execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${asarHash}`, plist]);
for (const attr of ['com.apple.FinderInfo','com.apple.ResourceFork']) {
  try { execFileSync('/usr/bin/xattr', ['-dr',attr,app], {stdio:'pipe'}); } catch {}
}
// Nested-first Electron signer, not blanket --deep signing. The exception is
// necessary for an ad-hoc preview to load Electron's differently signed dylibs.
await signAsync({app, platform:'darwin', identity:'-', identityValidation:false,
  preAutoEntitlements:false, preEmbedProvisioningProfile:false, strictVerify:true,
  optionsForFile:()=>({hardenedRuntime:true,timestamp:'none',entitlements:[
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.disable-library-validation'
  ]})});
execFileSync('/usr/bin/codesign', ['--verify','--deep','--strict','--verbose=2',app], {stdio:'inherit'});
await symlink('/Applications',join(stage,'Applications'));
const dmg = join(work,'ClawRouter-0.1.1-arm64.dmg');
execFileSync('/usr/bin/hdiutil',['create','-volname','ClawRouter 0.1.1-arm64','-srcfolder',stage,'-format','UDZO','-ov',dmg],{stdio:'inherit'});
execFileSync('/usr/bin/hdiutil',['verify',dmg],{stdio:'inherit'});
const zip = join(work,'ClawRouter-0.1.1-arm64-mac.zip');
execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,zip]);
const hashes = await Promise.all([dmg,zip].map(async path => `${sha(await readFile(path))}  ${path.split('/').pop()}`));
await writeFile(join(work,'SHA256SUMS.txt'),hashes.join('\n')+'\n');
await writeFile(join(work,'BUILD-PROVENANCE.json'),JSON.stringify({
  type:'signing-only-repack',version:'0.1.1',inputHash,originalRelease:'desktop-v0.1.0-preview.1',
  originalSourceCommit:'d36ede8e25fa8124ee7a6724edb57e4a50c84835',mainSha256:oldMain,preloadSha256:oldPreload,
  signature:'ad-hoc',notarized:false,quarantineRemoved:false,
  signerVersion:require('@electron/osx-sign/package.json').version
},null,2)+'\n');
console.log(`RELEASE_DIR=${work}`);
