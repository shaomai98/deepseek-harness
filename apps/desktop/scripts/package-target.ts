/** Build one release target with matching Electron and dsh architecture. */

import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { satisfies, valid } from 'semver'
import { packedManifest } from '../../../scripts/release/tarball.ts'
import {
  desktopBuildRecordFilename,
  resolveDesktopAutoUpdateConfig,
} from './desktop-auto-update-environment.mjs'
import { desktopArtifactOutput, desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { packageMacOSArtifacts, type DesktopPrepackagedArtifact } from './package-macos.ts'
import { loadDesktopPackageEnvironment, localMacOSPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createPackagingRun, recordPackagingEvent } from './packaging-run.mjs'
import { withWindowsSigningStage } from './windows-signing-stage.mjs'
import { prepareWindowsSignatureCacheDirectory, resolveWindowsSignatureCacheDirectory } from './windows-signature-cache-directory.mjs'
import { withMacOSSigningKeychain } from './macos-signing-keychain.mjs'
import { macOSDownloadEnvironment, resolveMacOSPackageSettings } from './macos-package-settings.mjs'
import { resolveWindowsPackageSettings } from './windows-package-settings.mjs'
import { packagingErrorDetails, packagingStep } from './packaging-step.mjs'
import { notarizeMacOS } from './notarize-macos.mjs'
import { resolveMacOSNotarizationEnvironment } from './desktop-release-environment.mjs'
import { DESKTOP_BUILD_VERSION_ENV, resolveDesktopBuildVersion, validateDesktopBuildVersion } from './desktop-build-version.mjs'
import { suggestDesktopBuildVersion } from './desktop-build-version-discovery.ts'
import { desktopBuildCommitEnvironment, readDesktopBuildCommit, resolveDesktopBuildCommit } from './desktop-build-commit.mjs'
import { requireDesktopToolchain } from './desktop-toolchain-preflight.ts'
import { withMacOSNotarizationProxy } from './macos-notarization-proxy.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const WINDOWS_SIGNING_ENV_PREFIX = 'DSH_DESKTOP_WINDOWS_'
const WINDOWS_SIGNING_ENV_NAMES = [
  'DSH_DESKTOP_WINDOWS_CER_FILE',
  'DSH_DESKTOP_WINDOWS_KEY_CONTAINER',
  'DSH_DESKTOP_WINDOWS_SIGNTOOL',
  'DSH_DESKTOP_WINDOWS_TOKEN_PIN',
  'DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR',
  'DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY',
] as const
const DESKTOP_UPLOAD_CREDENTIAL_ENV_NAMES = new Set([
  'DOWNLOAD_TEST_COS_SECRET_ID',
  'DOWNLOAD_TEST_COS_SECRET_KEY',
  'DOWNLOAD_PROD_COS_SECRET_ID',
  'DOWNLOAD_PROD_COS_SECRET_KEY',
])

/** `--build-version` value that numbers a build after the ones already taken. */
const AUTOMATIC_BUILD_VERSION = 'auto'

/** Fixed platform and architecture identifiers exposed by package scripts. */
export type DesktopPackageTargetName = 'mac-arm64' | 'mac-x64' | 'win-x64'

/** One supported release target and its electron-builder selectors. */
export interface DesktopPackageTarget {
  readonly name: DesktopPackageTargetName
  readonly platform: 'darwin' | 'win32'
  readonly arch: 'arm64' | 'x64'
  readonly builderPlatform: '--mac' | '--win'
  readonly builderArch: '--arm64' | '--x64'
}

const TARGETS: Record<DesktopPackageTargetName, DesktopPackageTarget> = {
  'mac-arm64': {
    name: 'mac-arm64',
    platform: 'darwin',
    arch: 'arm64',
    builderPlatform: '--mac',
    builderArch: '--arm64',
  },
  'mac-x64': {
    name: 'mac-x64',
    platform: 'darwin',
    arch: 'x64',
    builderPlatform: '--mac',
    builderArch: '--x64',
  },
  'win-x64': {
    name: 'win-x64',
    platform: 'win32',
    arch: 'x64',
    builderPlatform: '--win',
    builderArch: '--x64',
  },
}

/**
 * Remove Windows signing configuration from package preparation subprocesses.
 * @param environment - Packaging command environment.
 * @returns A copy without Windows signing fields.
 */
export function withoutWindowsSigningEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !name.startsWith(WINDOWS_SIGNING_ENV_PREFIX)))
}

/**
 * Select signing mode and strip unsigned-build credentials for packaging subprocesses.
 * @param environment - Target packaging environment.
 * @param unsigned - Whether to create a local artifact without release signing or notarization.
 * @returns Packaging environment without certificate inputs for unsigned builds.
 */
export function desktopElectronBuilderEnvironment(environment: NodeJS.ProcessEnv, unsigned: boolean): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { ...environment, DSH_DESKTOP_UNSIGNED: unsigned ? '1' : '0' }
  // The bundled NSIS decoder cannot extract 7-Zip's automatic ARM64-filtered entries.
  if (environment.DSH_DESKTOP_TARGET_PLATFORM === 'win32') selected.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'
  if (!unsigned) return selected
  return {
    ...Object.fromEntries(Object.entries(withoutWindowsSigningEnvironment(selected))
      .filter(([name]) => !/^(?:(?:WIN_)?CSC_|APPLE_|DSH_DESKTOP_MACOS_(?:SIGNING_|TEAM_ID$))/iu.test(name))),
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    DSH_DESKTOP_UNSIGNED: '1',
  }
}

/**
 * Remove upload-only COS credentials from every packaging subprocess.
 * @param environment - Packaging command environment.
 * @returns A copy without Desktop upload credentials.
 */
export function withoutDesktopUploadCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !DESKTOP_UPLOAD_CREDENTIAL_ENV_NAMES.has(name)))
}

function isTargetName(value: string): value is DesktopPackageTargetName {
  return Object.hasOwn(TARGETS, value)
}

function packageVersion(path: string, label: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`desktop package: ${label} has no version`)
  }
  return manifest.version
}

function writeReleaseRecord(
  target: DesktopPackageTarget,
  environment: NodeJS.ProcessEnv,
  artifactsRoot: string,
): void {
  const desktopVersion = packageVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = packageVersion(join(REPOSITORY_ROOT, 'package.json'), 'dsh package')
  if (desktopVersion !== dshVersion) {
    throw new Error(`desktop package: desktop version ${desktopVersion} does not match dsh version ${dshVersion}`)
  }
  const buildVersion = resolveDesktopBuildVersion(environment, dshVersion)
  const packaged = resolveDesktopBuildCommit(environment)
  const update = resolveDesktopAutoUpdateConfig(environment, target.platform, target.arch)
  const recordPath = join(artifactsRoot, desktopBuildRecordFilename(target.name))
  const temporaryPath = `${recordPath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify({
    schemaVersion: 1,
    target: target.name,
    version: buildVersion,
    environment: update.environment,
    channel: update.channel,
    publicUrl: update.publicUrl,
    // Upload reads this to tag the commit a production release was packaged from.
    ...packaged === undefined ? {} : { commit: packaged.commit, dirty: packaged.dirty },
  }, null, 2)}\n`)
  renameSync(temporaryPath, recordPath)
}

/**
 * Resolve a named release target and reject hosts that cannot execute its packaged runtime.
 * @param name - One of the fixed Desktop release target names.
 * @param hostPlatform - Build-host Node.js platform.
 * @param hostArch - Build-host Node.js architecture.
 * @returns The target selectors shared by runtime preparation and electron-builder.
 */
export function resolveDesktopPackageTarget(
  name: string,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DesktopPackageTarget {
  if (!isTargetName(name)) {
    throw new Error(`desktop package: unsupported target ${JSON.stringify(name)}; expected ${Object.keys(TARGETS).join(', ')}`)
  }
  const target = TARGETS[name]
  if (target.platform === 'win32' && (hostPlatform !== 'win32' || hostArch !== 'x64')) {
    throw new Error('desktop package: win-x64 requires a Windows x64 build host')
  }
  if (target.platform === 'darwin' && hostPlatform !== 'darwin') {
    throw new Error(`desktop package: ${name} requires a macOS build host`)
  }
  if (name === 'mac-arm64' && hostArch !== 'arm64') {
    throw new Error('desktop package: mac-arm64 requires an Apple Silicon build host')
  }
  if (name === 'mac-x64' && hostArch !== 'arm64' && hostArch !== 'x64') {
    throw new Error('desktop package: mac-x64 requires an Intel Mac or Apple Silicon with Rosetta')
  }
  return target
}

interface DesktopPackageInvocation {
  readonly target: DesktopPackageTarget
  readonly directory: boolean
  readonly prepareOnly: boolean
  readonly unsigned: boolean
  readonly skipNotarization: boolean
  readonly check: boolean
  /** Build identifier to publish under, when this build does not publish the product version. */
  readonly requestedBuildVersion: string | undefined
}

function hostTargetName(platform: NodeJS.Platform, arch: string): DesktopPackageTargetName {
  const name = `${platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform}-${arch}`
  if (!isTargetName(name)) throw new Error(`desktop package: unsupported build host ${platform}-${arch}`)
  return name
}

/**
 * Parse the fixed-target packaging command line.
 * @param argv - Arguments after the script entry point.
 * @param hostPlatform - Build-host Node.js platform.
 * @param hostArch - Build-host Node.js architecture.
 * @returns The validated target and whether to emit an unpacked directory.
 */
export function parseDesktopPackageInvocation(
  argv: readonly string[],
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): DesktopPackageInvocation {
  const { values, positionals } = parseArgs({
    // `pnpm run <script> -- --build-version x` forwards the separator itself, and the script's own
    // preset arguments come first, so it can land anywhere; parseArgs would read the rest as targets.
    args: argv.filter(argument => argument !== '--'),
    allowPositionals: true,
    options: {
      dir: { type: 'boolean', default: false },
      'prepare-only': { type: 'boolean', default: false },
      unsigned: { type: 'boolean', default: false },
      'skip-notarization': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'build-version': { type: 'string' },
    },
  })
  if (positionals.length > 1) throw new Error('desktop package: expected at most one target')
  const name = positionals[0] ?? hostTargetName(hostPlatform, hostArch)
  if (values.unsigned && values['prepare-only']) throw new Error('desktop package: --unsigned cannot use --prepare-only')
  if (values['skip-notarization'] && (name === 'win-x64' || values.unsigned || values['prepare-only'])) {
    throw new Error('desktop package: --skip-notarization requires a signed macOS build, without --prepare-only')
  }
  const requestedBuildVersion = values['build-version']?.trim()
  if (values['build-version'] !== undefined && (requestedBuildVersion === undefined || requestedBuildVersion === '')) {
    throw new Error('desktop package: --build-version requires a value')
  }
  return {
    target: resolveDesktopPackageTarget(name, hostPlatform, hostArch),
    directory: values.dir,
    prepareOnly: values['prepare-only'],
    unsigned: values.unsigned,
    skipNotarization: values['skip-notarization'],
    check: values.check,
    requestedBuildVersion,
  }
}

/**
 * Build the electron-builder command arguments for one validated target.
 * @param target - Supported release target.
 * @param directory - Whether to stop at an unpacked application directory.
 * @param artifact - Optional single artifact built from an existing signed application.
 * @returns Arguments that keep publishing under the separate validated upload command.
 */
export function desktopElectronBuilderArguments(
  target: DesktopPackageTarget,
  directory: boolean,
  artifact?: DesktopPrepackagedArtifact,
): readonly string[] {
  return [
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.config.mjs',
    target.builderPlatform,
    ...(artifact === undefined ? [] : [artifact.format]),
    target.builderArch,
    '--publish',
    'never',
    ...(directory ? ['--dir'] : []),
    ...(artifact === undefined ? [] : [
      ...(target.platform === 'darwin' ? ['--config.mac.notarize=false'] : []),
      '--prepackaged', artifact.appPath,
      '--config.directories.output', artifact.output,
    ]),
  ]
}

/**
 * Run `tar` beside the archive so Windows drive-letter paths are not treated as remote hosts.
 * @param archive - Absolute `.tgz` path.
 * @param args - Arguments after the archive basename handling (caller supplies `-xzf` / `-czf` forms via helper).
 * @param options - Optional cwd override and stdin.
 * @returns Combined stdout.
 */
function runTarBesideArchive(
  archive: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): string {
  const cwd = options.cwd ?? dirname(archive)
  const result = spawnSync('tar', args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`desktop package: tar ${args.join(' ')} failed: ${result.stderr || result.stdout || String(result.status)}`)
  }
  return result.stdout
}

/** One packed npm tarball indexed by package name for bkms peer checks. */
interface PackedPackageIndexEntry {
  readonly path: string
  readonly version: string
  readonly manifest: Readonly<Record<string, unknown>>
}

/**
 * Index every `.tgz` under the given pack output directories by package name.
 * @param directories - `packedDsh` / `packedVendor` style directories.
 * @returns Map of package name → packed identity.
 */
function indexPackedTarballs(directories: readonly string[]): Map<string, PackedPackageIndexEntry> {
  const index = new Map<string, PackedPackageIndexEntry>()
  for (const directory of directories) {
    if (!existsSync(directory)) continue
    for (const file of readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()) {
      const path = join(directory, file)
      const manifest = packedManifest(path)
      const name = manifest.name
      const version = manifest.version
      if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
        throw new Error(`desktop package: packed tarball ${path} lacks name/version`)
      }
      const previous = index.get(name)
      if (previous !== undefined) {
        throw new Error(`desktop package: duplicate packed ${name}: ${previous.path} and ${path}`)
      }
      index.set(name, { path, version, manifest })
    }
  }
  return index
}

/**
 * Locate the unique packed tarball whose `package/package.json` names `packageName`.
 * @param index - Packed tarball index.
 * @param packageName - Expected `name` field.
 * @returns Absolute tarball path.
 */
function findPackedTarballByName(index: ReadonlyMap<string, PackedPackageIndexEntry>, packageName: string): string {
  const entry = index.get(packageName)
  if (entry === undefined) {
    throw new Error(`desktop package: packed inputs omit ${packageName}`)
  }
  return entry.path
}

/**
 * Walk the packed dependency / peer / optional graph rooted at `@deepseek-ai/dsh`.
 * @param index - Packed tarball index.
 * @returns Package name → version for every reachable packed package.
 */
function packedDshClosureVersions(index: ReadonlyMap<string, PackedPackageIndexEntry>): Map<string, string> {
  const versions = new Map<string, string>()
  const visit = (name: string): void => {
    if (versions.has(name)) return
    const packed = index.get(name)
    if (packed === undefined) return
    versions.set(name, packed.version)
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const value = packed.manifest[section]
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      for (const dependency of Object.keys(value as Record<string, unknown>)) visit(dependency)
    }
  }
  visit('@deepseek-ai/dsh')
  return versions
}

/**
 * Resolve the version this packaging run actually ships for one `@deepseek-ai/*` peer.
 * Prefers the packed tarball's own version; falls back to the dsh packed closure.
 * @param name - Peer package name.
 * @param packed - Packed tarball index.
 * @param closure - Versions reachable from packed `@deepseek-ai/dsh`.
 * @returns Actual version and a short provenance label.
 */
function resolveBkmsPeerActualVersion(
  name: string,
  packed: ReadonlyMap<string, PackedPackageIndexEntry>,
  closure: ReadonlyMap<string, string>,
): { version: string; source: string } {
  const direct = packed.get(name)
  if (direct !== undefined) {
    return { version: direct.version, source: `packed tarball ${basename(direct.path)}` }
  }
  const fromClosure = closure.get(name)
  if (fromClosure !== undefined) {
    return { version: fromClosure, source: 'packed @deepseek-ai/dsh dependency closure' }
  }
  throw new Error(
    `desktop package: bkms peerDependency ${name} is not in this packaging run's packed tarballs or dsh closure`,
  )
}

/**
 * Whether a peerDependency declaration accepts the version this run packs.
 * Exact versions use string equality; ranges use `semver.satisfies` with prereleases included.
 * @param actual - Version present in this packaging run.
 * @param peer - PeerDependency value from XBuddy.
 * @returns True when the peer accepts `actual`.
 */
function bkmsPeerAcceptsVersion(actual: string, peer: string): boolean {
  if (actual === peer) return true
  if (valid(peer) !== null) return false
  return satisfies(actual, peer, { includePrerelease: true })
}

/**
 * Rewrite an npm pack tarball's `package/package.json` while keeping the `package/` prefix
 * and preserving sibling entry modes/mtimes as far as `tar` extract+create allows.
 * @param tarball - Absolute path of the tarball to replace in place.
 * @param rewrite - Mutates the parsed manifest before it is written back.
 */
function rewritePackedPackageManifest(
  tarball: string,
  rewrite: (manifest: Record<string, unknown>) => void,
): void {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-bkms-dsh-tgz-'))
  try {
    runTarBesideArchive(tarball, ['-xzf', basename(tarball), '-C', staging], { cwd: dirname(tarball) })
    const manifestPath = join(staging, 'package', 'package.json')
    if (!existsSync(manifestPath)) {
      throw new Error(`desktop package: ${tarball} has no package/package.json`)
    }
    const previous = statSync(manifestPath)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    rewrite(manifest)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
    try {
      utimesSync(manifestPath, previous.atime, previous.mtime)
    } catch (error) {
      // Windows and some CI filesystems refuse utimes; content correctness matters more.
      void error
    }
    const temporary = join(dirname(tarball), `.${basename(tarball)}.bkms-tmp`)
    rmSync(temporary, { force: true })
    runTarBesideArchive(temporary, ['-czf', basename(temporary), '-C', staging, 'package'], { cwd: dirname(tarball) })
    renameSync(temporary, tarball)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * // bkms: After `release:pack`, wire CI-built XBuddy into Desktop pack inputs without touching the repo lockfile.
 *
 * Copies `DSH_BKMS_XBUDDY_TGZ` into `packedVendor` and adds an exact `@bkms/bundle` dependency to the
 * packed `@deepseek-ai/dsh` tarball so `selectDesktopPackageClosure` and the installAnchor both see it.
 * Skips with a warning when the env var is unset or the file is missing (local / upstream builds).
 *
 * @param packedDsh - `release:pack --family dsh` output directory.
 * @param packedVendor - `release:pack --family vendor` output directory (also receives the XBuddy tgz).
 */
export function injectBkmsBundleIntoDesktopPack(packedDsh: string, packedVendor: string): void {
  // bkms:
  const xbuddyTgz = process.env.DSH_BKMS_XBUDDY_TGZ?.trim()
  if (xbuddyTgz === undefined || xbuddyTgz === '') {
    process.stderr.write('desktop package: bkms skipped (DSH_BKMS_XBUDDY_TGZ unset)\n')
    return
  }
  if (!existsSync(xbuddyTgz)) {
    process.stderr.write(`desktop package: bkms skipped (missing tgz: ${xbuddyTgz})\n`)
    return
  }

  const xbuddy = packedManifest(xbuddyTgz)
  if (xbuddy.name !== '@bkms/bundle') {
    throw new Error(`desktop package: bkms expected @bkms/bundle, got ${String(xbuddy.name)}`)
  }
  if (typeof xbuddy.version !== 'string' || xbuddy.version === '') {
    throw new Error('desktop package: bkms XBuddy tgz has no version')
  }
  const bundleVersion = xbuddy.version

  const packedIndex = indexPackedTarballs([packedDsh, packedVendor])
  const dshTarball = findPackedTarballByName(packedIndex, '@deepseek-ai/dsh')
  const closureVersions = packedDshClosureVersions(packedIndex)

  const peers = xbuddy.peerDependencies
  if (peers !== null && typeof peers === 'object' && !Array.isArray(peers)) {
    for (const [name, peerValue] of Object.entries(peers as Record<string, unknown>)) {
      if (!name.startsWith('@deepseek-ai/')) continue
      if (typeof peerValue !== 'string' || peerValue === '') {
        throw new Error(`desktop package: bkms peerDependency ${name} must be a non-empty string`)
      }
      const actual = resolveBkmsPeerActualVersion(name, packedIndex, closureVersions)
      if (!bkmsPeerAcceptsVersion(actual.version, peerValue)) {
        throw new Error(
          `desktop package: bkms peerDependency ${name} expected ${JSON.stringify(peerValue)}, `
          + `actual ${JSON.stringify(actual.version)} (from ${actual.source})`,
        )
      }
    }
  }

  rewritePackedPackageManifest(dshTarball, (manifest) => {
    const dependencies = manifest.dependencies
    const next = (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies))
      ? { ...dependencies as Record<string, string> }
      : {}
    next['@bkms/bundle'] = bundleVersion
    manifest.dependencies = next
  })

  mkdirSync(packedVendor, { recursive: true })
  const vendorDestination = join(packedVendor, basename(xbuddyTgz))
  copyFileSync(xbuddyTgz, vendorDestination)
  process.stdout.write(
    `desktop package: bkms wired @bkms/bundle@${bundleVersion} into ${basename(dshTarball)}; copied ${basename(xbuddyTgz)} -> ${vendorDestination}\n`,
  )
}

function runPnpm(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = APP_ROOT,
  run?: ReturnType<typeof createPackagingRun>,
): Promise<void> {
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry === undefined || pnpmEntry === '') {
    throw new Error('desktop package: invoke this script through a pnpm package command')
  }
  if (run !== undefined) return run.run(args.join(' '), process.execPath, [pnpmEntry, ...args], { cwd, env })
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [pnpmEntry, ...args], {
      cwd,
      env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop package: pnpm ${args.join(' ')} exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * Resolve the version one run publishes from what its command line asked for.
 * @param invocation - Validated packaging request.
 * @param productVersion - Version the manifests declare.
 * @param environment - Release settings, which name the bucket automatic numbering reads.
 * @returns The product version, the requested version, or the next free index for today.
 */
async function resolveRequestedBuildVersion(
  invocation: DesktopPackageInvocation,
  productVersion: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const requested = invocation.requestedBuildVersion
  if (requested === undefined) return productVersion
  if (requested !== AUTOMATIC_BUILD_VERSION) return validateDesktopBuildVersion(requested, productVersion)
  const paths = desktopTargetBuildPaths(invocation.target.name)
  return suggestDesktopBuildVersion({
    productVersion, target: invocation.target.name,
    // Machine presets own packaging, not upload credentials; local auto numbering uses existing artifacts.
    environment: environment.DSH_PACKAGING_PRESET === undefined ? environment : {},
    // Unsigned builds land beside the signed output, so numbering has to read the directory this run writes.
    artifactsRoot: desktopArtifactOutput(paths, invocation).directory,
  })
}

async function main(): Promise<void> {
  const invocation = parseDesktopPackageInvocation(process.argv.slice(2))
  const { target } = invocation
  if (invocation.skipNotarization) {
    process.stdout.write('desktop package: skipping notarization and stapling; internal debugging only, not qualified for distribution or update publishing\n')
  }
  const environment = target.platform === 'darwin' && invocation.unsigned
    ? localMacOSPackageEnvironment()
    : loadDesktopPackageEnvironment(target.platform, process.env, APP_ROOT, {
      unsigned: invocation.unsigned, prepareOnly: invocation.prepareOnly,
    })
  const productVersion = packageVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  // Release settings come from the selected configuration files, so the version this run publishes is an
  // argument; the environment variable below only carries it to the child processes that build.
  const buildVersion = await resolveRequestedBuildVersion(invocation, productVersion, environment)
  environment[DESKTOP_BUILD_VERSION_ENV] = buildVersion
  if (invocation.check) {
    validateDesktopPackageEnvironment(environment, target, invocation)
    await requireDesktopToolchain(target.platform, environment)
    process.stdout.write(`desktop package: ${target.name} would publish ${buildVersion}; local configuration and toolchain valid, signing and notarization were not attempted\n`)
    return
  }
  process.stdout.write(`desktop package: ${target.name} publishes ${buildVersion}${buildVersion === productVersion ? '' : ` for product version ${productVersion}`}\n`)
  const packaged = readDesktopBuildCommit(REPOSITORY_ROOT)
  Object.assign(environment, desktopBuildCommitEnvironment(packaged))
  const secrets = Object.entries(environment).filter(([name]) => /KEY|SECRET|TOKEN|PASSWORD|APPLE_ID/iu.test(name)).map(([, value]) => value ?? '')
  const run = createPackagingRun(join(APP_ROOT, '.desktop-build', 'packaging-runs'), {
    target: target.name, unsigned: invocation.unsigned, skipNotarization: invocation.skipNotarization,
    directory: invocation.directory, prepareOnly: invocation.prepareOnly,
    version: buildVersion, productVersion, node: process.version,
    commit: packaged.commit,
    dirty: packaged.dirty,
  }, { parallel: target.platform === 'darwin', secrets })
  console.log(`DESKTOP_PACKAGING_RECORD ${run.directory}`)
  const previousDirectory = process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
  process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = run.directory
  let success = false
  try {
    await packagingStep(run.directory, 'configuration', async () => { validateDesktopPackageEnvironment(environment, target, invocation) }, secrets)
    await packagingStep(run.directory, 'toolchain', () => requireDesktopToolchain(target.platform, environment), secrets)
    if (target.platform === 'darwin') {
      const settings = resolveMacOSPackageSettings(environment)
      recordPackagingEvent(run.directory, { type: 'macos-settings', packConcurrency: settings.packConcurrency,
        downloadProxyConfigured: settings.downloadProxy !== undefined,
        notarizationProxyConfigured: settings.notarizationProxy !== undefined })
      await packagingStep(run.directory, 'macos-package', () => invocation.unsigned
        ? packageTarget(invocation, environment, run)
        : withMacOSSigningKeychain(environment, signingEnvironment => packageTarget(invocation, signingEnvironment, run)), secrets)
    } else {
      await packagingStep(run.directory, 'windows-package', () => packageTarget(invocation, environment, run), secrets)
    }
    success = true
  } catch (error) {
    process.stderr.write(`${packagingErrorDetails(error, secrets)}\n`)
    process.stderr.write(`desktop package: failed; see ${run.directory}/events.jsonl\n`)
    process.exitCode = 1
  } finally {
    if (previousDirectory === undefined) delete process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
    else process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = previousDirectory
    run.finish(success)
  }
  if (success && target.platform === 'darwin' && !invocation.directory && !invocation.prepareOnly) {
    const paths = desktopTargetBuildPaths(target.name)
    const output = desktopArtifactOutput(paths, invocation)
    const filename = `deepseek-harness-${buildVersion}-mac-${target.arch}${output.suffix}.dmg`
    console.log(`DMG: ${join(output.directory, filename)}`)
  }
}

/**
 * Prepare one release only after its signing preflight, without publishing from the builder.
 * @param invocation Validated host, target and packaging mode.
 * @param environment File-owned release configuration.
 * @param run Persistent stage supervisor; required for signed Windows packaging and enabled for all release commands.
 * @returns Resolves after preparation or complete packaging; any failed stage prevents a release record.
 */
export async function packageTarget(
  invocation: DesktopPackageInvocation,
  environment: NodeJS.ProcessEnv,
  run: ReturnType<typeof createPackagingRun> | undefined,
): Promise<void> {
  const { target } = invocation
  const execute = (args: readonly string[], env: NodeJS.ProcessEnv, cwd: string = APP_ROOT) => runPnpm(args, env, cwd, run)
  const journal = target.platform === 'darwin' ? process.env.DSH_DESKTOP_PACKAGING_RUN_DIR : undefined
  const proxyEvent = (status: string) => { if (journal) recordPackagingEvent(journal, { type: 'notarization-proxy', status }) }
  const mac = target.platform === 'darwin' ? resolveMacOSPackageSettings(environment) : undefined
  const packConcurrency = mac?.packConcurrency ?? (target.platform === 'win32'
    ? resolveWindowsPackageSettings(environment).packConcurrency : undefined)
  const packArguments = packConcurrency === undefined ? [] : ['--concurrency', String(packConcurrency)]
  const buildPaths = desktopTargetBuildPaths(target.name)
  const releaseRecordPath = join(buildPaths.artifacts, desktopBuildRecordFilename(target.name))
  if (!invocation.prepareOnly && !invocation.unsigned && !invocation.skipNotarization) {
    rmSync(releaseRecordPath, { force: true })
    rmSync(`${releaseRecordPath}.tmp`, { force: true })
  }
  const artifactsRoot = desktopArtifactOutput(buildPaths, invocation).directory
  const buildEnv = withoutWindowsSigningEnvironment(withoutDesktopUploadCredentials(
    desktopElectronBuilderEnvironment(environment, invocation.unsigned)))
  const targetEnv: NodeJS.ProcessEnv = {
    ...buildEnv,
    DSH_DESKTOP_MACOS_SKIP_NOTARIZATION: invocation.skipNotarization ? '1' : '0',
    DSH_DESKTOP_TARGET_PLATFORM: target.platform,
    DSH_DESKTOP_TARGET_ARCH: target.arch,
  }
  const downloadEnv = macOSDownloadEnvironment(targetEnv, mac?.downloadProxy)
  const electronBuilderEnv = desktopElectronBuilderEnvironment(downloadEnv, invocation.unsigned)
  for (const name of WINDOWS_SIGNING_ENV_NAMES) {
    if (!invocation.unsigned && environment[name] !== undefined) electronBuilderEnv[name] = environment[name]
  }
  const signPrimaryRuntime = target.platform === 'win32' && !invocation.unsigned && !invocation.prepareOnly
  const signedStage = async (stage: string, operation: () => Promise<void>): Promise<void> => {
    if (!signPrimaryRuntime) return operation()
    if (run === undefined) throw new Error('desktop package: signed Windows packaging requires a supervised run')
    const controller = new AbortController()
    const interrupted = (): void => controller.abort()
    const detach = (): void => {
      process.removeListener('SIGINT', interrupted)
      process.removeListener('SIGTERM', interrupted)
    }
    process.once('SIGINT', interrupted)
    process.once('SIGTERM', interrupted)
    try {
      const options = { stage, signal: controller.signal, record: (event: object): void => recordPackagingEvent(run.directory, event) }
      await withWindowsSigningStage(options, async () => {
        detach()
        await operation()
      })
    } finally { detach() }
  }
  if (signPrimaryRuntime) {
    if (run === undefined) throw new Error('desktop package: signed Windows packaging requires a supervised run')
    await signedStage('preflight', async () => {
      await prepareWindowsSignatureCacheDirectory(resolveWindowsSignatureCacheDirectory(environment))
      await run.run('preflight:windows-signing', process.execPath,
        ['--import', 'tsx/esm', join(APP_ROOT, 'scripts/windows-signing-preflight.ts')],
        { cwd: APP_ROOT, env: electronBuilderEnv, timeoutMs: 60_000 })
    })
  }
  await execute(['run', 'build:official'], buildEnv, REPOSITORY_ROOT)
  await execute(['run', 'release:pack', '--family', 'dsh', '--out', buildPaths.packedDsh, ...packArguments], buildEnv, REPOSITORY_ROOT)
  await execute([
    '--dir',
    'apps/desktop-host',
    'pack',
    '--pack-destination',
    buildPaths.packedDsh,
  ], buildEnv, REPOSITORY_ROOT)
  await execute(['run', 'release:pack', '--family', 'vendor', '--out', buildPaths.packedVendor, ...packArguments], buildEnv, REPOSITORY_ROOT)
  // bkms: 改 packed @deepseek-ai/dsh 的 dependencies，并拷 XBuddy tgz 进 packedVendor（不改仓库 lockfile）。
  injectBkmsBundleIntoDesktopPack(buildPaths.packedDsh, buildPaths.packedVendor)
  rmSync(buildPaths.packedLandlock, { recursive: true, force: true })
  mkdirSync(buildPaths.packedLandlock, { recursive: true })
  await execute(['--dir', 'native/system', 'run', 'build:ts'], buildEnv, REPOSITORY_ROOT)
  await execute([
    '--dir',
    'native/system/packages/entry',
    'pack',
    '--pack-destination',
    buildPaths.packedLandlock,
  ], buildEnv, REPOSITORY_ROOT)
  await execute(['run', 'prepare:runtime', ...(signPrimaryRuntime ? ['--defer-primary-runtime-smoke'] : [])], downloadEnv)
  if (signPrimaryRuntime) await execute(['run', 'sign:primary-runtime'], electronBuilderEnv)
  await execute(['run', 'prepare:packages'], targetEnv)
  await execute(['run', 'prepare:dsh', ...(signPrimaryRuntime ? ['--defer-runtime-smoke'] : [])], downloadEnv)
  if (signPrimaryRuntime) await execute(['run', 'sign:primary-runtime', '--dsh'], electronBuilderEnv)
  if (invocation.prepareOnly) return
  if (target.platform === 'darwin' && !invocation.unsigned && !invocation.skipNotarization && !invocation.directory) {
    await execute([
      ...desktopElectronBuilderArguments(target, true),
      '--config.mac.notarize=false',
    ], electronBuilderEnv)
    await execute(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts'], targetEnv)
    await withMacOSNotarizationProxy(mac?.notarizationProxy, () => packageMacOSArtifacts({
      arch: target.arch,
      // electron-builder named these artifacts after the published version, so locating them uses the same identifier.
      version: resolveDesktopBuildVersion(environment, packageVersion(join(APP_ROOT, 'package.json'), 'desktop package')),
      artifactsRoot: buildPaths.artifacts,
      environment: electronBuilderEnv,
    }, artifact => execute(desktopElectronBuilderArguments(target, false, artifact), electronBuilderEnv)), undefined, undefined, proxyEvent)
  } else if (target.platform === 'darwin' && !invocation.unsigned && !invocation.skipNotarization) {
    await execute([...desktopElectronBuilderArguments(target, true), '--config.mac.notarize=false'], electronBuilderEnv)
    await execute(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts'], targetEnv)
    const appPath = join(buildPaths.artifacts, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app')
    await withMacOSNotarizationProxy(mac?.notarizationProxy,
      () => notarizeMacOS({ appPath, ...resolveMacOSNotarizationEnvironment(environment) }), undefined, undefined, proxyEvent)
  } else {
    await signedStage('artifacts', () => execute(desktopElectronBuilderArguments(target, invocation.directory), electronBuilderEnv))
    await execute(['exec', 'tsx', 'scripts/smoke-packaged-runtime.ts',
      ...(invocation.unsigned ? ['--unsigned'] : []), ...(invocation.skipNotarization ? ['--skip-notarization'] : [])], targetEnv)
  }
  if (!invocation.directory && !invocation.unsigned && !invocation.skipNotarization) {
    writeReleaseRecord(target, electronBuilderEnv, buildPaths.artifacts)
  }
  if (journal) recordPackagingEvent(journal, { type: 'artifacts', directory: artifactsRoot })
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
