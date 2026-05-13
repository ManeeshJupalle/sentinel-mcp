import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

import { walkRepo } from "../src/utils/file-walker.js";
import { analyzeDeadCode } from "../src/analyzers/dead-code-analyzer.js";
import { handleGetHealthReport } from "../src/tools/get-health-report.js";

async function makeRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sentinel-rp-"));
}

test("walkRepo: relative repoPath produces absolute paths", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const x = 1;\n");

    // Drive walkRepo with a relative path: chdir into the temp dir and pass ".".
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const files = await walkRepo(".", { sourceOnly: true });
      assert.ok(files.length > 0, "expected at least one source file");
      for (const f of files) {
        assert.ok(
          isAbsolute(f.absolutePath),
          `expected absolute path, got ${f.absolutePath}`
        );
      }
    } finally {
      process.chdir(cwd);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("analyzeDeadCode: relative repoPath matches absolute repoPath", async () => {
  // The audit found analyzeDeadCode(".") reporting 100% unused exports while
  // analyzeDeadCode(absolute) reported the real number. Now that walkRepo
  // normalizes the root, both inputs must produce identical reports.
  const dir = await makeRepo();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "lib.ts"),
      "export function used() { return 1; }\nexport function unused() { return 2; }\n"
    );
    await writeFile(
      join(dir, "src", "consumer.ts"),
      'import { used } from "./lib.js";\nconsole.log(used());\n'
    );
    await writeFile(join(dir, "index.ts"), 'import "./src/consumer.js";\n');

    const absolute = await analyzeDeadCode(resolve(dir));

    const cwd = process.cwd();
    process.chdir(dir);
    let relative;
    try {
      relative = await analyzeDeadCode(".");
    } finally {
      process.chdir(cwd);
    }

    assert.equal(absolute.total_exports, relative.total_exports);
    assert.equal(absolute.unused_count, relative.unused_count);
    assert.equal(absolute.unused_percentage, relative.unused_percentage);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleGetHealthReport: missing path returns null score + error, not A+", async () => {
  const missing = join(
    tmpdir(),
    "sentinel-definitely-missing-" + Date.now() + "-" + Math.random()
  );
  const r = await handleGetHealthReport({ repo_path: missing });
  assert.equal(
    r.score,
    null,
    `expected null score for missing path, got ${r.score}`
  );
  assert.equal(r.grade, "N/A");
  assert.ok(
    r.error?.includes(missing),
    `expected error to mention the bad path, got: ${r.error}`
  );
  for (const c of Object.values(r.breakdown)) {
    assert.equal(c.score, null);
    assert.ok(c.error);
  }
});

test("handleGetHealthReport: valid path returns a numeric score", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const x = 1;\n");
    await writeFile(join(dir, "package.json"), '{"name":"tmp","version":"0.0.0"}\n');
    const r = await handleGetHealthReport({ repo_path: dir });
    assert.equal(typeof r.score, "number");
    assert.ok(r.score !== null && r.score >= 0 && r.score <= 100);
    assert.notEqual(r.grade, "N/A");
    assert.equal(r.error, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
