#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ReleaseKind = "patch" | "minor" | "major";

const kind = process.argv[2] as ReleaseKind | undefined;
if (!kind || !["patch", "minor", "major"].includes(kind)) {
  console.error("Usage: bun run scripts/version.ts <patch|minor|major>");
  process.exit(1);
}

function bump(version: string, release: ReleaseKind) {
  const [major, minor, patch] = version.split(".").map(Number);
  if ([major, minor, patch].some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid semver: ${version}`);
  }
  if (release === "major") return `${major + 1}.0.0`;
  if (release === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const rootPackagePath = join(process.cwd(), "package.json");
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf-8")) as {
  version: string;
};
const nextVersion = bump(rootPackage.version, kind);

// Update root package.json
const pkg = JSON.parse(readFileSync(rootPackagePath, "utf-8")) as Record<
  string,
  unknown
>;
pkg.version = nextVersion;
writeFileSync(rootPackagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Updated package.json -> ${nextVersion}`);
