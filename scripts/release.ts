#!/usr/bin/env bun

import { execSync } from "node:child_process";

type ReleaseKind = "patch" | "minor" | "major";
const kind = (process.argv[2] as ReleaseKind | undefined) ?? "patch";
if (!["patch", "minor", "major"].includes(kind)) {
  console.error("Usage: bun run scripts/release.ts [patch|minor|major]");
  process.exit(1);
}

function run(command: string) {
  execSync(command, { stdio: "inherit" });
}

// Ensure working tree is clean
const status = execSync("git status --porcelain", { encoding: "utf8" }).trim();
if (status) {
  console.error("Working tree is not clean. Commit or stash changes first.");
  process.exit(1);
}

run("bun run check");

// Bump version
run(`bun run scripts/version.ts ${kind}`);

const version = execSync(
  'node -p "require(\'./package.json\').version"',
  {
    encoding: "utf8",
  },
).trim();

run("git add -A");
run(`git commit -m "chore: release v${version}"`);
run(`git tag -a "v${version}" -m "Release v${version}"`);

console.log(`\n✅ Release v${version} prepared locally.`);
console.log(`   Push with: git push origin main --tags`);
