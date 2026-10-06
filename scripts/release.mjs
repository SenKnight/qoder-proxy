#!/usr/bin/env node
// One-command release for qoder-proxy.
//
// Runs the local checks, bumps the version, then pushes the commit and the
// `vX.Y.Z` tag. Pushing the tag triggers the Release workflow, which builds the
// package, publishes it to npm with provenance, and creates/updates the GitHub
// Release. Zero runtime dependencies.
//
// Usage:
//   npm run release            # patch bump (default)
//   npm run release -- minor   # minor / major / explicit X.Y.Z
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUMP_RE = /^(patch|minor|major|premajor|preminor|prepatch|prerelease)$/;

function fail(message) {
  console.error(`\n\u2716 ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed:\n${result.stderr?.trim() ?? ""}`);
  return result.stdout.trim();
}

const bump = process.argv[2] ?? "patch";
if (!BUMP_RE.test(bump) && !/^\d+\.\d+\.\d+/.test(bump)) {
  fail(`Unknown bump "${bump}". Use patch | minor | major | <explicit X.Y.Z>.`);
}

// Guardrails: never cut a release from a dirty tree or a non-main branch.
if (capture("git", ["status", "--porcelain"]) !== "") {
  fail("Working tree is not clean. Commit or stash your changes first.");
}
const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`Releases are cut from "main" (currently on "${branch}").`);

console.log("\n\u25b6 Running checks (check / lint / test / build)\u2026");
run("npm", ["run", "check"]);
run("npm", ["run", "lint"]);
run("npm", ["test"]);
run("npm", ["run", "build"]);

console.log(`\n\u25b6 Bumping version (${bump})\u2026`);
run("npm", ["version", bump]);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${pkg.version}`;
const repoUrl = String(pkg.repository?.url ?? "")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");

console.log(`\n\u25b6 Pushing main + ${tag}\u2026`);
run("git", ["push", "origin", "main", "--follow-tags"]);

console.log(`\n\u2714 Pushed ${tag}. The tag triggered the Release workflow.`);
console.log(
  "  Watch: gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')",
);
if (repoUrl) console.log(`  Release: ${repoUrl}/releases/tag/${tag}`);
