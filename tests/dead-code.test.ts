import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeDeadCode } from "../src/analyzers/dead-code-analyzer.js";

async function makeRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sentinel-dc-"));
}

test("export default function Name is not flagged when imported as default", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "lib.ts"),
      "export default function NamedDefault() { return 1; }\n" +
        "export function used() { return 2; }\n"
    );
    await writeFile(
      join(dir, "src", "other.ts"),
      'import named from "./lib.js";\nimport { used } from "./lib.js";\nconsole.log(named(), used());\n'
    );
    // Make `other.ts` referenced so it isn't itself flagged via wildcard;
    // index.ts at repo root is an entry point and excluded.
    await writeFile(
      join(dir, "index.ts"),
      'import "./src/other.js";\n'
    );

    const r = await analyzeDeadCode(dir);
    const symbols = r.potentially_dead_exports.map((e) => e.symbol);
    assert.ok(
      !symbols.includes("NamedDefault"),
      `NamedDefault should not be flagged dead, got: ${JSON.stringify(symbols)}`
    );
    assert.ok(
      !symbols.includes("default"),
      `default should not be flagged dead, got: ${JSON.stringify(symbols)}`
    );
    assert.ok(
      !symbols.includes("used"),
      `used should not be flagged dead, got: ${JSON.stringify(symbols)}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("export default class Name is not flagged when imported as default", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "lib.ts"),
      "export default class Widget { greet() { return 'hi'; } }\n"
    );
    await writeFile(
      join(dir, "src", "other.ts"),
      'import Widget from "./lib.js";\nconsole.log(new Widget().greet());\n'
    );
    await writeFile(join(dir, "index.ts"), 'import "./src/other.js";\n');

    const r = await analyzeDeadCode(dir);
    const symbols = r.potentially_dead_exports.map((e) => e.symbol);
    assert.ok(!symbols.includes("Widget"));
    assert.ok(!symbols.includes("default"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Python: `from . import foo` marks foo.py's exports as used", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(join(dir, "pkg"), { recursive: true });
    await writeFile(join(dir, "pkg", "__init__.py"), "");
    await writeFile(
      join(dir, "pkg", "foo.py"),
      "def used():\n    return 1\n\ndef helper():\n    return 2\n"
    );
    await writeFile(
      join(dir, "pkg", "main.py"),
      "from . import foo\nfoo.used()\n"
    );

    const r = await analyzeDeadCode(dir);
    const deadInFoo = r.potentially_dead_exports.filter(
      (e) => e.file.endsWith("foo.py")
    );
    // `from . import foo` is a wildcard import of foo.py — neither used nor
    // helper should be flagged dead, even though only `used` is called.
    assert.deepEqual(
      deadInFoo,
      [],
      `expected no dead exports in foo.py, got ${JSON.stringify(deadInFoo)}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Python: `from .pkg import foo` (submodule) marks foo as used", async () => {
  const dir = await makeRepo();
  try {
    await mkdir(join(dir, "outer", "pkg"), { recursive: true });
    await writeFile(join(dir, "outer", "__init__.py"), "");
    await writeFile(join(dir, "outer", "pkg", "__init__.py"), "");
    await writeFile(
      join(dir, "outer", "pkg", "foo.py"),
      "def used():\n    return 1\n"
    );
    await writeFile(
      join(dir, "outer", "main.py"),
      "from .pkg import foo\nfoo.used()\n"
    );

    const r = await analyzeDeadCode(dir);
    const deadInFoo = r.potentially_dead_exports.filter((e) =>
      e.file.endsWith("foo.py")
    );
    assert.deepEqual(deadInFoo, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("genuinely unused exports are flagged", async () => {
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

    const r = await analyzeDeadCode(dir);
    const symbols = r.potentially_dead_exports.map((e) => e.symbol);
    assert.ok(symbols.includes("unused"), `expected 'unused' to be flagged, got: ${JSON.stringify(symbols)}`);
    assert.ok(!symbols.includes("used"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
