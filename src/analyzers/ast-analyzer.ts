/**
 * AST Analyzer — Phase 2
 *
 * Tree-sitter based AST parsing and cyclomatic complexity calculation.
 * Supports TypeScript, TSX, JavaScript, and Python.
 */

import { readFile } from "node:fs/promises";
import Parser from "tree-sitter";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — package's index.d.ts uses `export =` shape that's unfriendly to ESM types
import TSLangs from "tree-sitter-typescript";
// @ts-ignore
import JSLang from "tree-sitter-javascript";
// @ts-ignore
import PyLang from "tree-sitter-python";

import { walkRepo, type FileEntry } from "../utils/file-walker.js";
import { detectLanguage } from "../utils/language-detect.js";

type SyntaxNode = Parser.SyntaxNode;
// tree-sitter@0.21.x doesn't export a Language type — setLanguage() accepts any
// language object exposed by a grammar package.
type Language = unknown;

export type Severity = "low" | "moderate" | "high" | "critical";

export interface ComplexityResult {
  file: string;
  function_name: string;
  line: number;
  complexity: number;
  severity: Severity;
}

export interface ComplexityReport {
  files_analyzed: number;
  total_functions: number;
  high_complexity_functions: ComplexityResult[];
  average_complexity: number;
  distribution: { low: number; moderate: number; high: number; critical: number };
}

type LangKey = "typescript" | "tsx" | "javascript" | "python";

// ─── Language node-type tables ───────────────────────────────────────

const FUNCTION_TYPES_JS = new Set<string>([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function",
  "generator_function_declaration",
]);

const DECISION_TYPES_JS = new Set<string>([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);

const FUNCTION_TYPES_PY = new Set<string>(["function_definition"]);

const DECISION_TYPES_PY = new Set<string>([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "conditional_expression",
  "boolean_operator",
]);

// ─── Parser cache ─────────────────────────────────────────────────────

const parserCache = new Map<LangKey, Parser>();

function getParser(lang: LangKey): Parser {
  const cached = parserCache.get(lang);
  if (cached) return cached;

  const parser = new Parser();
  let language: Language;
  switch (lang) {
    case "typescript":
      language = TSLangs.typescript as Language;
      break;
    case "tsx":
      language = TSLangs.tsx as Language;
      break;
    case "javascript":
      language = JSLang as Language;
      break;
    case "python":
      language = PyLang as Language;
      break;
  }
  parser.setLanguage(language);
  parserCache.set(lang, parser);
  return parser;
}

function languageKeyFor(filePath: string): LangKey | null {
  const info = detectLanguage(filePath);
  if (!info) return null;
  switch (info.id) {
    case "typescript":
      return "typescript";
    case "tsx":
      return "tsx";
    case "javascript":
      return "javascript";
    case "python":
      return "python";
    default:
      return null;
  }
}

function isPython(lang: LangKey): boolean {
  return lang === "python";
}

// ─── Complexity calculation ───────────────────────────────────────────

function isFunctionNode(type: string, lang: LangKey): boolean {
  return isPython(lang) ? FUNCTION_TYPES_PY.has(type) : FUNCTION_TYPES_JS.has(type);
}

function isDecisionNode(node: SyntaxNode, lang: LangKey): boolean {
  if (isPython(lang)) {
    return DECISION_TYPES_PY.has(node.type);
  }
  if (DECISION_TYPES_JS.has(node.type)) return true;
  if (node.type === "binary_expression") {
    const op = node.childForFieldName("operator");
    if (op) {
      const t = op.text;
      return t === "&&" || t === "||" || t === "??";
    }
  }
  return false;
}

/**
 * Cyclomatic complexity: 1 + count of decision points within the function body,
 * excluding any decisions inside nested function definitions (those are counted
 * separately as their own functions).
 */
function computeComplexity(funcNode: SyntaxNode, lang: LangKey): number {
  let count = 1;

  const walk = (node: SyntaxNode) => {
    for (const child of node.namedChildren) {
      // Don't descend into nested functions — they get their own entry
      if (isFunctionNode(child.type, lang)) continue;
      if (isDecisionNode(child, lang)) count++;
      walk(child);
    }
  };

  walk(funcNode);
  return count;
}

function collectFunctions(root: SyntaxNode, lang: LangKey): SyntaxNode[] {
  const functions: SyntaxNode[] = [];
  const walk = (node: SyntaxNode) => {
    if (isFunctionNode(node.type, lang)) functions.push(node);
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return functions;
}

/**
 * Best-effort name extraction. Falls back to "<anonymous>" for arrow functions
 * or function expressions that aren't bound to a recognizable name.
 */
function getFunctionName(node: SyntaxNode): string {
  const direct = node.childForFieldName("name");
  if (direct) return direct.text;

  const parent = node.parent;
  if (!parent) return "<anonymous>";

  switch (parent.type) {
    case "variable_declarator": {
      const id = parent.childForFieldName("name");
      if (id) return id.text;
      break;
    }
    case "assignment_expression":
    case "augmented_assignment_expression": {
      const left = parent.childForFieldName("left");
      if (left) return left.text;
      break;
    }
    case "pair": {
      const key = parent.childForFieldName("key");
      if (key) return key.text;
      break;
    }
    case "public_field_definition":
    case "field_definition":
    case "property_signature": {
      const propName = parent.childForFieldName("name");
      if (propName) return propName.text;
      break;
    }
  }
  return "<anonymous>";
}

export function classifySeverity(complexity: number): Severity {
  if (complexity <= 4) return "low";
  if (complexity <= 10) return "moderate";
  if (complexity <= 20) return "high";
  return "critical";
}

// ─── Per-file analysis ────────────────────────────────────────────────

export interface FileComplexity {
  file: string;
  functions: ComplexityResult[];
}

export async function analyzeFileComplexity(
  file: FileEntry
): Promise<FileComplexity | null> {
  const lang = languageKeyFor(file.absolutePath);
  if (!lang) return null;

  let source: string;
  try {
    source = await readFile(file.absolutePath, "utf-8");
  } catch {
    return null;
  }
  if (source.includes("\0")) return null; // binary

  let tree;
  try {
    const parser = getParser(lang);
    tree = parser.parse(source);
  } catch {
    return null;
  }
  if (!tree) return null;

  const functions = collectFunctions(tree.rootNode, lang);
  const results: ComplexityResult[] = [];

  for (const fn of functions) {
    const complexity = computeComplexity(fn, lang);
    results.push({
      file: file.relativePath,
      function_name: getFunctionName(fn),
      line: fn.startPosition.row + 1,
      complexity,
      severity: classifySeverity(complexity),
    });
  }

  return { file: file.relativePath, functions: results };
}

// ─── Repo-level analysis ──────────────────────────────────────────────

function emptyComplexityReport(): ComplexityReport {
  return {
    files_analyzed: 0,
    total_functions: 0,
    high_complexity_functions: [],
    average_complexity: 0,
    distribution: { low: 0, moderate: 0, high: 0, critical: 0 },
  };
}

export async function analyzeComplexity(
  repoPath: string,
  options: { pathFilter?: string; threshold?: number } = {}
): Promise<ComplexityReport> {
  try {
    return await analyzeComplexityImpl(repoPath, options);
  } catch (err) {
    console.error(
      "[sentinel] complexity analysis failed:",
      err instanceof Error ? err.message : err
    );
    return emptyComplexityReport();
  }
}

async function analyzeComplexityImpl(
  repoPath: string,
  options: { pathFilter?: string; threshold?: number }
): Promise<ComplexityReport> {
  const threshold = options.threshold ?? 10;

  const files = await walkRepo(repoPath, {
    sourceOnly: true,
    pathFilter: options.pathFilter,
  });

  const allFunctions: ComplexityResult[] = [];
  let filesAnalyzed = 0;

  for (const file of files) {
    const result = await analyzeFileComplexity(file);
    if (result === null) continue;
    filesAnalyzed++;
    allFunctions.push(...result.functions);
  }

  const distribution = { low: 0, moderate: 0, high: 0, critical: 0 };
  let totalComplexity = 0;
  for (const fn of allFunctions) {
    distribution[fn.severity]++;
    totalComplexity += fn.complexity;
  }

  const highComplexity = allFunctions
    .filter((f) => f.complexity >= threshold)
    .sort((a, b) => b.complexity - a.complexity);

  const averageComplexity =
    allFunctions.length === 0
      ? 0
      : Math.round((totalComplexity / allFunctions.length) * 10) / 10;

  return {
    files_analyzed: filesAnalyzed,
    total_functions: allFunctions.length,
    high_complexity_functions: highComplexity,
    average_complexity: averageComplexity,
    distribution,
  };
}
