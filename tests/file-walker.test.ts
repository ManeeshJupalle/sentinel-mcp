import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { countLines, walkRepo } from "../src/utils/file-walker.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sentinel-fw-"));
}

test("countLines: empty file is 0 lines", async () => {
  const dir = await makeTempDir();
  try {
    const f = join(dir, "empty.txt");
    await writeFile(f, "");
    assert.equal(await countLines(f), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("countLines: trailing newline does not count as an extra line", async () => {
  const dir = await makeTempDir();
  try {
    const f = join(dir, "trail.txt");
    await writeFile(f, "a\nb\nc\n");
    assert.equal(await countLines(f), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("countLines: file without trailing newline counts the last line", async () => {
  const dir = await makeTempDir();
  try {
    const f = join(dir, "notrail.txt");
    await writeFile(f, "a\nb\nc");
    assert.equal(await countLines(f), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("countLines: single newline is one (empty) line", async () => {
  const dir = await makeTempDir();
  try {
    const f = join(dir, "nl.txt");
    await writeFile(f, "\n");
    assert.equal(await countLines(f), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("walkRepo: path_filter that escapes the repo returns []", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const x = 1;\n");
    const escaped = await walkRepo(dir, { pathFilter: ".." });
    assert.deepEqual(escaped, []);
    const escaped2 = await walkRepo(dir, { pathFilter: "../../" });
    assert.deepEqual(escaped2, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("walkRepo: missing directory returns []", async () => {
  const result = await walkRepo(
    join(tmpdir(), "sentinel-does-not-exist-" + Date.now())
  );
  assert.deepEqual(result, []);
});
