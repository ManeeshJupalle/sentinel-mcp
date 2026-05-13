/**
 * Dead Code Analyzer — Phase 4
 *
 * Parses every source file with Tree-sitter, extracts every export and import
 * declaration, resolves relative import paths, and reports exports that no
 * other file in the repo imports. Entry-point files (index.*, package.json
 * `main`/`bin`, repo-root files) are excluded from being flagged.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import Parser from "tree-sitter";
// @ts-ignore — package's index.d.ts uses `export =` shape that's unfriendly to ESM types
import TSLangs from "tree-sitter-typescript";
// @ts-ignore
import JSLang from "tree-sitter-javascript";
// @ts-ignore
import PyLang from "tree-sitter-python";

import { walkRepo, type FileEntry } from "../utils/file-walker.js";
import { detectLanguage } from "../utils/language-detect.js";

type SyntaxNode = Parser.SyntaxNode;
type Language = unknown;
type LangKey = "typescript" | "tsx" | "javascript" | "python";

export type ExportSymbolType =
  | "function"
  | "class"
  | "variable"
  | "type"
  | "interface"
  | "enum"
  | "default";

export interface DeadExport {
  file: string;
  symbol: string;
  line: number;
  type: ExportSymbolType;
}

export interface DeadCodeReport {
  potentially_dead_exports: DeadExport[];
  total_exports: number;
  unused_count: number;
  unused_percentage: number;
  warnings?: string[];
}

interface ExportInfo {
  absPath: string;
  relPath: string;
  symbol: string;
  line: number;
  type: ExportSymbolType;
}

interface RawImport {
  source: string;
  /** Imported names; "*" represents a namespace/wildcard import */
  names: string[] | "*";
  line: number;
}

interface FileAnalysis {
  abs: string;
  rel: string;
  lang: LangKey;
  exports: ExportInfo[];
  rawImports: RawImport[];
}

// ─── Parser setup ────────────────────────────────────────────────────

const parserCache = new Map<LangKey, Parser>();

function getParser(lang: LangKey): Parser {
  const cached = parserCache.get(lang);
  if (cached) return cached;
  const parser = new Parser();
  switch (lang) {
    case "typescript":
      parser.setLanguage(TSLangs.typescript as Language);
      break;
    case "tsx":
      parser.setLanguage(TSLangs.tsx as Language);
      break;
    case "javascript":
      parser.setLanguage(JSLang as Language);
      break;
    case "python":
      parser.setLanguage(PyLang as Language);
      break;
  }
  parserCache.set(lang, parser);
  return parser;
}

function langKeyFor(filePath: string): LangKey | null {
  const info = detectLanguage(filePath);
  if (!info) return null;
  if (
    info.id === "typescript" ||
    info.id === "tsx" ||
    info.id === "javascript" ||
    info.id === "python"
  ) {
    return info.id;
  }
  return null;
}

function isJsLike(lang: LangKey): boolean {
  return lang !== "python";
}

// ─── Helpers ─────────────────────────────────────────────────────────

function normalize(p: string): string {
  return p.split(sep).join("/");
}

function readStringLiteral(node: SyntaxNode): string {
  const text = node.text;
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function jsTypeFromDeclaration(node: SyntaxNode): ExportSymbolType {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_expression":
    case "arrow_function":
    case "function":
      return "function";
    case "class_declaration":
    case "abstract_class_declaration":
    case "class":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    default:
      return "variable";
  }
}

// ─── JS/TS export extraction ─────────────────────────────────────────

function extractFromDeclaration(
  decl: SyntaxNode,
  rel: string,
  abs: string,
  baseLine: number
): ExportInfo[] {
  const out: ExportInfo[] = [];
  const push = (symbol: string, type: ExportSymbolType, line: number) =>
    out.push({ absPath: abs, relPath: rel, symbol, line, type });

  switch (decl.type) {
    case "function_declaration":
    case "generator_function_declaration": {
      const name = decl.childForFieldName("name");
      if (name) push(name.text, "function", decl.startPosition.row + 1);
      break;
    }
    case "class_declaration":
    case "abstract_class_declaration": {
      const name = decl.childForFieldName("name");
      if (name) push(name.text, "class", decl.startPosition.row + 1);
      break;
    }
    case "interface_declaration": {
      const name = decl.childForFieldName("name");
      if (name) push(name.text, "interface", decl.startPosition.row + 1);
      break;
    }
    case "type_alias_declaration": {
      const name = decl.childForFieldName("name");
      if (name) push(name.text, "type", decl.startPosition.row + 1);
      break;
    }
    case "enum_declaration": {
      const name = decl.childForFieldName("name");
      if (name) push(name.text, "enum", decl.startPosition.row + 1);
      break;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      for (const child of decl.namedChildren) {
        if (child.type !== "variable_declarator") continue;
        const name = child.childForFieldName("name");
        if (name && name.type === "identifier") {
          push(name.text, "variable", child.startPosition.row + 1);
        }
        // destructuring patterns are skipped — too speculative to attribute symbols
      }
      break;
    }
  }
  if (out.length === 0) {
    // Fallback: if we don't recognize the declaration, ignore it
    void baseLine;
  }
  return out;
}

// ─── JS/TS export-statement handlers ──────────────────────────────────
//
// Each helper handles one shape of `export_statement` and pushes any
// exports/imports it discovers into the caller-owned arrays. Keeping them
// small and shape-specific keeps the top-level dispatcher legible — the
// AST has a half-dozen distinct export forms and folding them into one
// function makes the cyclomatic complexity unreadable.

interface JsExportCtx {
  abs: string;
  rel: string;
  exports: ExportInfo[];
  rawImports: RawImport[];
}

/** `export { x, y as z } from "./foo"`, `export * from "./foo"`, `export * as ns from "./foo"`. */
function handleJsReExport(
  stmt: SyntaxNode,
  sourceField: SyntaxNode,
  ctx: JsExportCtx
): void {
  const sourcePath = readStringLiteral(sourceField);
  const stmtLine = stmt.startPosition.row + 1;

  const exportClause = stmt.namedChildren.find(
    (c) => c.type === "export_clause"
  );
  const namespaceExport = stmt.namedChildren.find(
    (c) => c.type === "namespace_export"
  );

  if (!exportClause && !namespaceExport) {
    // `export * from "./foo"` — bare star re-export.
    if (stmt.children.some((c) => c.type === "*")) {
      ctx.rawImports.push({ source: sourcePath, names: "*", line: stmtLine });
    }
    return;
  }

  if (namespaceExport) {
    // `export * as ns from "./foo"`: the underlying module is wildcard-imported,
    // and `ns` becomes a new local export.
    ctx.rawImports.push({ source: sourcePath, names: "*", line: stmtLine });
    const id =
      namespaceExport.childForFieldName("name") ??
      namespaceExport.namedChildren.find((c) => c.type === "identifier");
    if (id) {
      ctx.exports.push({
        absPath: ctx.abs,
        relPath: ctx.rel,
        symbol: id.text,
        line: stmtLine,
        type: "variable",
      });
    }
    return;
  }

  // `export { x, y as z } from "./foo"`: each spec becomes both an import of
  // the original name from the source module AND a re-export of the alias
  // (or name) from this file.
  const reExportNames: string[] = [];
  for (const spec of exportClause!.namedChildren) {
    if (spec.type !== "export_specifier") continue;
    const name = spec.childForFieldName("name");
    const alias = spec.childForFieldName("alias");
    if (name) reExportNames.push(name.text);
    const exposed = alias?.text ?? name?.text;
    if (exposed) {
      ctx.exports.push({
        absPath: ctx.abs,
        relPath: ctx.rel,
        symbol: exposed,
        line: stmtLine,
        type: "variable",
      });
    }
  }
  if (reExportNames.length > 0) {
    ctx.rawImports.push({
      source: sourcePath,
      names: reExportNames,
      line: stmtLine,
    });
  }
}

/** `export function f()`, `export class C`, `export const x = ...`, `export default function Name()`, etc. */
function handleJsDeclarationExport(
  stmt: SyntaxNode,
  declField: SyntaxNode,
  ctx: JsExportCtx
): void {
  const stmtLine = stmt.startPosition.row + 1;

  // `export default function Name() {}` / `export default class Name {}`:
  // tree-sitter exposes the declaration under `declaration`, but the
  // *exported* identity is `default` — that's what importers see. The local
  // name `Name` is just a binding for self-reference inside the module.
  const isDefault = stmt.children.some(
    (c) => c.type === "default" || c.text === "default"
  );
  if (isDefault) {
    ctx.exports.push({
      absPath: ctx.abs,
      relPath: ctx.rel,
      symbol: "default",
      line: stmtLine,
      type: jsTypeFromDeclaration(declField),
    });
    return;
  }
  ctx.exports.push(
    ...extractFromDeclaration(declField, ctx.rel, ctx.abs, stmtLine)
  );
}

/** `export default <expression>` (anonymous function, object literal, etc.). */
function handleJsDefaultValueExport(
  stmt: SyntaxNode,
  valueField: SyntaxNode,
  ctx: JsExportCtx
): void {
  const stmtLine = stmt.startPosition.row + 1;
  const type = jsTypeFromDeclaration(valueField);
  ctx.exports.push({
    absPath: ctx.abs,
    relPath: ctx.rel,
    symbol: "default",
    line: stmtLine,
    type: type === "variable" ? "default" : type,
  });
}

/** `export { a, b as c }` — no source, no declaration, no value. */
function handleJsNamedExport(stmt: SyntaxNode, ctx: JsExportCtx): void {
  const exportClause = stmt.namedChildren.find(
    (c) => c.type === "export_clause"
  );
  if (!exportClause) return;
  const stmtLine = stmt.startPosition.row + 1;
  for (const spec of exportClause.namedChildren) {
    if (spec.type !== "export_specifier") continue;
    const name = spec.childForFieldName("name");
    const alias = spec.childForFieldName("alias");
    const exposed = alias?.text ?? name?.text;
    if (!exposed) continue;
    ctx.exports.push({
      absPath: ctx.abs,
      relPath: ctx.rel,
      symbol: exposed,
      line: stmtLine,
      type: "variable",
    });
  }
}

function extractJsExportsAndImports(
  root: SyntaxNode,
  abs: string,
  rel: string
): { exports: ExportInfo[]; rawImports: RawImport[] } {
  const ctx: JsExportCtx = { abs, rel, exports: [], rawImports: [] };

  for (const child of root.namedChildren) {
    if (child.type === "import_statement") {
      collectJsImport(child, ctx.rawImports);
      continue;
    }
    if (child.type !== "export_statement") continue;

    const sourceField = child.childForFieldName("source");
    const declField = child.childForFieldName("declaration");
    const valueField = child.childForFieldName("value");

    if (sourceField) {
      handleJsReExport(child, sourceField, ctx);
    } else if (declField) {
      handleJsDeclarationExport(child, declField, ctx);
    } else if (valueField) {
      handleJsDefaultValueExport(child, valueField, ctx);
    } else {
      handleJsNamedExport(child, ctx);
    }
  }

  // Walk the tree for dynamic `import("...")` calls
  collectDynamicImports(root, ctx.rawImports);

  return { exports: ctx.exports, rawImports: ctx.rawImports };
}

function collectJsImport(stmt: SyntaxNode, out: RawImport[]): void {
  const sourceField = stmt.childForFieldName("source");
  if (!sourceField) return;
  const source = readStringLiteral(sourceField);
  const stmtLine = stmt.startPosition.row + 1;

  const clauses = stmt.namedChildren.filter((c) => c.type === "import_clause");
  if (clauses.length === 0) {
    // Side-effect import: `import "./x"` — record an edge with no names so
    // the file at least counts as "touched", but no symbol is marked used.
    out.push({ source, names: [], line: stmtLine });
    return;
  }

  let hasDefault = false;
  let hasNamespace = false;
  const names: string[] = [];

  for (const clause of clauses) {
    for (const c of clause.namedChildren) {
      if (c.type === "identifier") {
        hasDefault = true;
      } else if (c.type === "named_imports") {
        for (const spec of c.namedChildren) {
          if (spec.type !== "import_specifier") continue;
          const name = spec.childForFieldName("name");
          if (name) names.push(name.text);
        }
      } else if (c.type === "namespace_import") {
        hasNamespace = true;
      }
    }
  }

  if (hasNamespace) {
    out.push({ source, names: "*", line: stmtLine });
    return;
  }
  if (hasDefault) names.push("default");
  if (names.length > 0) {
    out.push({ source, names, line: stmtLine });
  } else {
    out.push({ source, names: [], line: stmtLine });
  }
}

function collectDynamicImports(node: SyntaxNode, out: RawImport[]): void {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn && fn.text === "import") {
      const args = node.childForFieldName("arguments");
      const first = args?.namedChildren[0];
      if (first && first.type === "string") {
        out.push({
          source: readStringLiteral(first),
          names: "*",
          line: node.startPosition.row + 1,
        });
      }
    }
  }
  for (const child of node.namedChildren) {
    collectDynamicImports(child, out);
  }
}

// ─── Python export/import extraction ─────────────────────────────────

// ─── Python export/import handlers ────────────────────────────────────

interface PyExportCtx {
  abs: string;
  rel: string;
  exports: ExportInfo[];
  rawImports: RawImport[];
  /** True if the module has an explicit `__all__` — narrows visible exports. */
  hasAll: boolean;
  /** Names listed in `__all__` when `hasAll` is true. */
  allNames: Set<string>;
}

/**
 * First pass: scan for `__all__ = [...]`. Returns true if present and
 * populates the name set the caller hands back in via PyExportCtx.
 */
function detectPyAllList(root: SyntaxNode, allNames: Set<string>): boolean {
  let hasAll = false;
  for (const child of root.namedChildren) {
    if (child.type !== "expression_statement") continue;
    const expr = child.namedChildren[0];
    if (!expr || expr.type !== "assignment") continue;
    const left = expr.childForFieldName("left");
    const right = expr.childForFieldName("right");
    if (left?.text !== "__all__" || right?.type !== "list") continue;
    hasAll = true;
    for (const item of right.namedChildren) {
      if (item.type === "string") allNames.add(readStringLiteral(item));
    }
  }
  return hasAll;
}

function pyIsExported(name: string, ctx: PyExportCtx): boolean {
  return ctx.hasAll ? ctx.allNames.has(name) : !name.startsWith("_");
}

/** `def f()` / `class C` at module top level. */
function handlePyDefinition(node: SyntaxNode, ctx: PyExportCtx): void {
  const name = node.childForFieldName("name");
  if (!name) return;
  const symbol = name.text;
  if (!pyIsExported(symbol, ctx)) return;
  ctx.exports.push({
    absPath: ctx.abs,
    relPath: ctx.rel,
    symbol,
    line: node.startPosition.row + 1,
    type: node.type === "class_definition" ? "class" : "function",
  });
}

/** Top-level `x = ...` assignments (single identifier on the left only). */
function handlePyAssignment(node: SyntaxNode, ctx: PyExportCtx): void {
  const expr = node.namedChildren[0];
  if (!expr || expr.type !== "assignment") return;
  const left = expr.childForFieldName("left");
  if (!left || left.type !== "identifier") return;
  const symbol = left.text;
  if (symbol === "__all__") return; // already handled in detectPyAllList
  if (!pyIsExported(symbol, ctx)) return;
  ctx.exports.push({
    absPath: ctx.abs,
    relPath: ctx.rel,
    symbol,
    line: node.startPosition.row + 1,
    type: "variable",
  });
}

/** `import foo`, `import foo.bar`, `import foo as f`. */
function handlePyImport(node: SyntaxNode, ctx: PyExportCtx): void {
  const line = node.startPosition.row + 1;
  for (const c of node.namedChildren) {
    let target = "";
    if (c.type === "dotted_name") {
      target = c.text;
    } else if (c.type === "aliased_import") {
      target = c.childForFieldName("name")?.text ?? "";
    }
    if (target) {
      ctx.rawImports.push({ source: target, names: "*", line });
    }
  }
}

/** `from <module> import a, b, c` and `from <module> import *`. */
function handlePyImportFrom(node: SyntaxNode, ctx: PyExportCtx): void {
  const moduleField = node.childForFieldName("module_name");
  const moduleSrc = moduleField?.text ?? "";
  if (!moduleSrc) return;

  const isWildcard = node.children.some(
    (c) => c.type === "*" || c.text === "*"
  );
  const line = node.startPosition.row + 1;

  if (isWildcard) {
    ctx.rawImports.push({ source: moduleSrc, names: "*", line });
    return;
  }

  const names: string[] = [];
  for (const c of node.namedChildren) {
    if (c === moduleField) continue;
    if (c.type === "dotted_name") {
      names.push(c.text);
    } else if (c.type === "aliased_import") {
      const orig = c.childForFieldName("name")?.text;
      if (orig) names.push(orig);
    }
  }
  ctx.rawImports.push({ source: moduleSrc, names, line });
}

function extractPyExportsAndImports(
  root: SyntaxNode,
  abs: string,
  rel: string
): { exports: ExportInfo[]; rawImports: RawImport[] } {
  const allNames = new Set<string>();
  const ctx: PyExportCtx = {
    abs,
    rel,
    exports: [],
    rawImports: [],
    hasAll: detectPyAllList(root, allNames),
    allNames,
  };

  for (const child of root.namedChildren) {
    switch (child.type) {
      case "function_definition":
      case "class_definition":
        handlePyDefinition(child, ctx);
        break;
      case "expression_statement":
        handlePyAssignment(child, ctx);
        break;
      case "import_statement":
        handlePyImport(child, ctx);
        break;
      case "import_from_statement":
        handlePyImportFrom(child, ctx);
        break;
    }
  }

  return { exports: ctx.exports, rawImports: ctx.rawImports };
}

// ─── Path resolution ─────────────────────────────────────────────────

const JS_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_INDEX_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const JS_TO_TS_RE = /\.([cm]?js|jsx)$/;

function resolveJsImport(
  importerAbs: string,
  importPath: string,
  files: Set<string>
): string | null {
  if (
    !importPath.startsWith(".") &&
    !importPath.startsWith("/") &&
    !isAbsolute(importPath)
  ) {
    return null; // external module (bare specifier)
  }
  const base = isAbsolute(importPath)
    ? importPath
    : resolve(dirname(importerAbs), importPath);

  for (const ext of JS_EXTS) {
    const candidate = base + ext;
    if (files.has(candidate)) return candidate;
  }

  // TS convention: `import "./foo.js"` resolves to `./foo.ts` on disk
  const m = base.match(JS_TO_TS_RE);
  if (m) {
    const stem = base.slice(0, base.length - m[0].length);
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
      const candidate = stem + ext;
      if (files.has(candidate)) return candidate;
    }
  }

  for (const ext of JS_INDEX_EXTS) {
    const candidate = join(base, "index" + ext);
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function resolvePyImport(
  importerAbs: string,
  importPath: string,
  files: Set<string>
): string | null {
  if (!importPath.startsWith(".")) {
    return null; // absolute Python import — can't reliably resolve without project config
  }

  // Count leading dots to determine how far up to walk
  let dots = 0;
  while (dots < importPath.length && importPath[dots] === ".") dots++;
  const remainder = importPath.slice(dots).replace(/\./g, "/");

  let dir = dirname(importerAbs);
  for (let i = 1; i < dots; i++) dir = dirname(dir);

  const base = remainder ? join(dir, remainder) : dir;
  const filePath = base + ".py";
  if (files.has(filePath)) return filePath;
  const initPath = join(base, "__init__.py");
  if (files.has(initPath)) return initPath;
  return null;
}

/**
 * For `from <source> import <name>`, the name might be a submodule rather
 * than a symbol of `source`. Try resolving `<source>.<name>` as a module.
 * Used to catch the `from . import foo` pattern, where the source ".".py
 * doesn't exist but `foo.py` is the actual import target.
 */
function resolvePySubmodule(
  importerAbs: string,
  source: string,
  name: string,
  files: Set<string>
): string | null {
  if (!source.startsWith(".")) return null;
  const combined = /^\.+$/.test(source) ? source + name : source + "." + name;
  return resolvePyImport(importerAbs, combined, files);
}

// ─── Entry point detection ───────────────────────────────────────────

const INDEX_NAMES = new Set([
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
  "__init__.py",
]);

async function loadEntryPoints(repoPath: string): Promise<Set<string>> {
  const entryPoints = new Set<string>();
  try {
    const pkgRaw = await readFile(join(repoPath, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw) as {
      main?: string;
      bin?: string | Record<string, string>;
      module?: string;
      exports?: unknown;
    };
    const candidates: string[] = [];
    if (typeof pkg.main === "string") candidates.push(pkg.main);
    if (typeof pkg.module === "string") candidates.push(pkg.module);
    if (typeof pkg.bin === "string") candidates.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === "object") {
      candidates.push(...Object.values(pkg.bin));
    }
    for (const c of candidates) {
      const abs = resolve(repoPath, c);
      entryPoints.add(abs);
      // Match TS source variants of compiled targets
      const m = abs.match(JS_TO_TS_RE);
      if (m) {
        const stem = abs.slice(0, abs.length - m[0].length);
        entryPoints.add(stem + ".ts");
        entryPoints.add(stem + ".tsx");
      }
    }
  } catch {
    // No package.json or unreadable — that's fine
  }
  return entryPoints;
}

function isEntryPointFile(
  file: { abs: string; rel: string },
  entryPoints: Set<string>
): boolean {
  // Match package.json main/bin entries
  if (entryPoints.has(file.abs)) return true;

  const normalizedRel = normalize(file.rel);
  // Repo-root files (no path separator in relative path)
  if (!normalizedRel.includes("/")) return true;

  // index.* / __init__.py at any depth
  const basename = normalizedRel.slice(normalizedRel.lastIndexOf("/") + 1);
  if (INDEX_NAMES.has(basename)) return true;

  return false;
}

// ─── Main analysis ───────────────────────────────────────────────────

async function analyzeFile(file: FileEntry): Promise<FileAnalysis | null> {
  const lang = langKeyFor(file.absolutePath);
  if (!lang) return null;

  let source: string;
  try {
    source = await readFile(file.absolutePath, "utf-8");
  } catch {
    return null;
  }
  if (source.includes("\0")) return null;

  let tree;
  try {
    tree = getParser(lang).parse(source);
  } catch {
    return null;
  }
  if (!tree) return null;

  const result = isJsLike(lang)
    ? extractJsExportsAndImports(
        tree.rootNode,
        file.absolutePath,
        file.relativePath
      )
    : extractPyExportsAndImports(
        tree.rootNode,
        file.absolutePath,
        file.relativePath
      );

  return {
    abs: file.absolutePath,
    rel: file.relativePath,
    lang,
    exports: result.exports,
    rawImports: result.rawImports,
  };
}

function emptyDeadCodeReport(): DeadCodeReport {
  return {
    potentially_dead_exports: [],
    total_exports: 0,
    unused_count: 0,
    unused_percentage: 0,
  };
}

export async function analyzeDeadCode(
  repoPath: string,
  options: { pathFilter?: string } = {}
): Promise<DeadCodeReport> {
  try {
    return await analyzeDeadCodeImpl(repoPath, options);
  } catch (err) {
    console.error(
      "[sentinel] dead code analysis failed:",
      err instanceof Error ? err.message : err
    );
    return emptyDeadCodeReport();
  }
}

async function analyzeDeadCodeImpl(
  repoPath: string,
  options: { pathFilter?: string }
): Promise<DeadCodeReport> {
  const files = await walkRepo(repoPath, {
    sourceOnly: true,
    pathFilter: options.pathFilter,
  });

  const fileSet = new Set<string>(files.map((f) => f.absolutePath));
  const analyses: FileAnalysis[] = [];

  for (const file of files) {
    const a = await analyzeFile(file);
    if (a) analyses.push(a);
  }

  // Used set: `${absPath}::${symbol}` — exports we know are imported somewhere.
  // wildcardSet: files for which someone did a `*` import — every export of
  // those files is considered used.
  const used = new Set<string>();
  const wildcards = new Set<string>();

  for (const a of analyses) {
    for (const imp of a.rawImports) {
      if (isJsLike(a.lang)) {
        const target = resolveJsImport(a.abs, imp.source, fileSet);
        if (!target) continue;
        if (imp.names === "*") {
          wildcards.add(target);
        } else {
          for (const name of imp.names) used.add(`${target}::${name}`);
        }
        continue;
      }

      // Python: `from <source> import a, b` is ambiguous between symbols of
      // <source> and submodules <source>.a / <source>.b. Resolve both paths
      // and mark whichever target(s) exist as used. This handles the common
      // `from . import foo` pattern where . resolves to __init__.py but the
      // real target is ./foo.py.
      const sourceTarget = resolvePyImport(a.abs, imp.source, fileSet);
      if (imp.names === "*") {
        if (sourceTarget) wildcards.add(sourceTarget);
        continue;
      }
      for (const name of imp.names) {
        const subTarget = resolvePySubmodule(
          a.abs,
          imp.source,
          name,
          fileSet
        );
        if (subTarget) wildcards.add(subTarget);
        if (sourceTarget) used.add(`${sourceTarget}::${name}`);
      }
    }
  }

  const entryPoints = await loadEntryPoints(repoPath);
  const allExports: ExportInfo[] = [];
  const dead: DeadExport[] = [];

  for (const a of analyses) {
    const isEntry = isEntryPointFile(
      { abs: a.abs, rel: a.rel },
      entryPoints
    );
    for (const exp of a.exports) {
      allExports.push(exp);
      if (isEntry) continue;
      if (wildcards.has(exp.absPath)) continue;
      if (used.has(`${exp.absPath}::${exp.symbol}`)) continue;
      dead.push({
        file: normalize(exp.relPath),
        symbol: exp.symbol,
        line: exp.line,
        type: exp.type,
      });
    }
  }

  dead.sort((a, b) => {
    const fileCmp = a.file.localeCompare(b.file);
    return fileCmp !== 0 ? fileCmp : a.line - b.line;
  });

  const total = allExports.length;
  const unusedPct =
    total === 0 ? 0 : Math.round((dead.length / total) * 1000) / 10;

  return {
    potentially_dead_exports: dead,
    total_exports: total,
    unused_count: dead.length,
    unused_percentage: unusedPct,
  };
}
