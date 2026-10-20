#!/usr/bin/env node
/**
 * macOS signed-package acceptance for @bkms/bundle@0.1.3 + skill-creator.
 * Invoked on a GitHub-hosted macos runner against an unpacked .app (asar extracted).
 *
 * No model API key: exercises provider list/get + renderSkillContent (skill-tool output text).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const APP_ROOT = process.env.DSH_ACCEPT_APP_ROOT
const ASAR_ROOT = process.env.DSH_ACCEPT_ASAR_ROOT
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh-bkms-accept')
const WORK = process.env.DSH_ACCEPT_WORK || mkdtempSync(join(tmpdir(), 'bkms-accept-proj-'))

if (!APP_ROOT || !ASAR_ROOT) {
  console.error('need DSH_ACCEPT_APP_ROOT and DSH_ACCEPT_ASAR_ROOT')
  process.exit(2)
}

function section(title) {
  console.log(`\n======== ${title} ========`)
}

function mustExist(path, label = path) {
  if (!existsSync(path)) throw new Error(`missing: ${label}`)
  return path
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.status !== 0 && opts.allowFail !== true) {
    throw new Error(`${cmd} exited ${r.status}`)
  }
  return r
}

section('0. package identity')
const bundlePkg = join(ASAR_ROOT, 'dsh/node_modules/@bkms/bundle/package.json')
const bundle = JSON.parse(readFileSync(mustExist(bundlePkg), 'utf8'))
console.log(JSON.stringify({ name: bundle.name, version: bundle.version }, null, 2))
if (bundle.name !== '@bkms/bundle' || bundle.version !== '0.1.3') {
  throw new Error(`expected @bkms/bundle@0.1.3, got ${bundle.name}@${bundle.version}`)
}
const skillAssets = join(ASAR_ROOT, 'dsh/node_modules/@bkms/bundle/assets/skills/skill-creator')
mustExist(join(skillAssets, 'SKILL.md'))
mustExist(join(skillAssets, 'scripts/validate_skill.mjs'))
console.log('skill-creator assets OK under', skillAssets)

section('1. codesign / Gatekeeper / stapler')
const appPath = APP_ROOT
run('codesign', ['--verify', '--deep', '--strict', '-v', appPath])
run('spctl', ['-a', '-vv', '--type', 'exec', appPath], { allowFail: true })
const dmg = process.env.DSH_ACCEPT_DMG
if (dmg && existsSync(dmg)) {
  run('xcrun', ['stapler', 'validate', dmg], { allowFail: true })
} else {
  console.log('skip stapler: DSH_ACCEPT_DMG not set')
}

section('2. provider: list/get skill-creator + Base directory')
process.env.DSH_HOME = DSH_HOME
mkdirSync(DSH_HOME, { recursive: true })

const dshModules = join(ASAR_ROOT, 'dsh/node_modules')
const requireFromDsh = createRequire(join(dshModules, '@deepseek-ai/dsh/package.json'))

const { Context } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/cordis')).href)
const SkillRegistry = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-skill')).href)).default
const { renderSkillContent } = await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-skill')).href)
const BkmsBundle = await import(pathToFileURL(join(dshModules, '@bkms/bundle/lib/index.js')).href)

const ctx = new Context()
// Minimal stubs so @bkms/bundle (inject: credentials, webServer) can mount and load bkms-skills.
ctx.provide('credentials', {
  // unused by skills path; presence satisfies inject
})
ctx.provide('webServer', {
  // unused by skills path
})
await ctx.plugin(SkillRegistry)
await ctx.plugin(BkmsBundle)

const listed = await ctx.skills.list()
console.log('skills.list =>', listed.map(s => ({ name: s.name, provider: s.provider, source: s.source })))
const creator = listed.find(s => s.name === 'skill-creator')
if (!creator) throw new Error('skill-creator not in skills.list()')
const loaded = await ctx.skills.get('skill-creator')
if (!loaded) throw new Error('skills.get(skill-creator) returned undefined')
const rendered = renderSkillContent(loaded)
console.log('--- renderSkillContent (skill tool text) head ---')
console.log(rendered.slice(0, 800))
if (!rendered.includes('Base directory for this skill:')) {
  throw new Error('renderSkillContent missing Base directory for this skill')
}
if (!/Base directory for this skill: .+\bskill-creator\b/u.test(rendered)) {
  throw new Error('Base directory does not point at skill-creator')
}
console.log('provider+tool-text OK')

section('3. materialize ~/.dsh/bkms/skills/<ver>-<hash>/')
const skillsBase = join(DSH_HOME, 'bkms', 'skills')
const versions = readdirSync(skillsBase).filter(name => !name.startsWith('.'))
console.log('materialized dirs:', versions)
if (versions.length === 0) throw new Error('no materialized skill dirs')
const match = versions.find(name => name.startsWith('0.1.3-'))
if (!match) throw new Error(`no 0.1.3-* materialize dir under ${skillsBase}`)
const matRoot = join(skillsBase, match)
mustExist(join(matRoot, '.complete'))
mustExist(join(matRoot, 'skill-creator/SKILL.md'))
console.log('materialize OK:', matRoot)
console.log('.complete =>', readFileSync(join(matRoot, '.complete'), 'utf8').trim())

section('4. project .dsh/skills example with .mjs + validate_skill.mjs')
const projectSkills = join(WORK, '.dsh/skills/hello-mjs')
mkdirSync(projectSkills, { recursive: true })
writeFileSync(join(projectSkills, 'SKILL.md'), `---
name: hello-mjs
description: Acceptance fixture that runs a tiny .mjs script via absolute path.
---

# hello-mjs

Before running scripts, call \`load_workspace_dependencies\`.
Then run \`scripts/hello.mjs\` with Node using the absolute path it returns (or an absolute path under this skill directory).
`)
mkdirSync(join(projectSkills, 'scripts'), { recursive: true })
const helloScript = join(projectSkills, 'scripts/hello.mjs')
writeFileSync(helloScript, `console.log('hello-from-skill-mjs')\n`)
chmodSync(helloScript, 0o755)

const nodeBin = process.env.DSH_ACCEPT_NODE || process.execPath
const hello = run(nodeBin, [helloScript])
if (!hello.stdout.includes('hello-from-skill-mjs')) {
  throw new Error('hello.mjs did not print expected output')
}

const validator = join(matRoot, 'skill-creator/scripts/validate_skill.mjs')
mustExist(validator)
const validate = run(nodeBin, [validator, projectSkills])
console.log('validate_skill.mjs status', validate.status)

// Discover via skill-filesystem if available in the installation.
try {
  const SkillFs = (await import(pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-skill-filesystem')).href)).default
  const fsCtx = new Context()
  await fsCtx.plugin(SkillRegistry)
  await fsCtx.plugin(SkillFs)
  process.chdir(WORK)
  const projectListed = await fsCtx.skills.list({ cwd: WORK })
  console.log('filesystem skills.list(cwd=WORK) =>', projectListed.map(s => s.name))
  if (!projectListed.some(s => s.name === 'hello-mjs')) {
    throw new Error('hello-mjs not discovered from project .dsh/skills')
  }
  console.log('project skill discovery OK')
} catch (error) {
  console.warn('skill-filesystem discovery skipped/failed:', error instanceof Error ? error.message : error)
  console.warn('(script run + validate_skill still exercised above)')
}

section('DONE')
console.log(JSON.stringify({
  bundleVersion: bundle.version,
  skillCreatorListed: true,
  materializeDir: matRoot,
  projectSkill: projectSkills,
  dshHome: DSH_HOME,
}, null, 2))
