/**
 * Dependency Analyzer — Phase 3
 *
 * Detects the package manager (npm, pip, or both) and shells out to the
 * appropriate audit + outdated commands. Parses the structured output into a
 * normalized vulnerability report. Failures (missing tooling, parse errors,
 * unsupported repos) are reported as warnings/error fields rather than throws.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const execAsync = promisify(exec);
const EXEC_OPTS = { maxBuffer: 50 * 1024 * 1024 };

export type Severity = "critical" | "high" | "moderate" | "low";

export interface Vulnerability {
  package: string;
  severity: string;
  current_version: string;
  patched_version: string;
  advisory: string;
}

export interface VulnerabilitySummary {
  critical: number;
  high: number;
  moderate: number;
  low: number;
}

export interface DependencyReport {
  package_manager: "npm" | "pip" | "npm+pip" | "none";
  total_dependencies: number;
  vulnerabilities: Vulnerability[];
  outdated_count: number;
  vulnerability_summary: VulnerabilitySummary;
  warnings?: string[];
  error?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  ok: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(cmd: string, cwd: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, ...EXEC_OPTS });
    return { stdout: String(stdout), stderr: String(stderr), ok: true };
  } catch (err: unknown) {
    // npm audit and `npm outdated` exit non-zero when findings exist, but
    // their stdout is still a valid JSON document — keep it.
    const e = err as { stdout?: unknown; stderr?: unknown };
    return {
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: e.stderr ? String(e.stderr) : "",
      ok: false,
    };
  }
}

function isCommandMissing(result: CommandResult): boolean {
  if (result.ok) return false;
  return /not (recognized|found)|ENOENT|command not found|is not recognized/i.test(
    result.stderr
  );
}

function emptySummary(): VulnerabilitySummary {
  return { critical: 0, high: 0, moderate: 0, low: 0 };
}

function bumpSeverity(summary: VulnerabilitySummary, severity: string): void {
  const key = severity.toLowerCase() as keyof VulnerabilitySummary;
  if (key in summary) summary[key]++;
}

// ─── npm ──────────────────────────────────────────────────────────────

interface NpmVuln {
  severity?: string;
  range?: string;
  via?: unknown;
  fixAvailable?: boolean | { version?: string };
}

interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmVuln>;
}

function extractNpmAdvisoryTitle(via: unknown): string {
  if (!Array.isArray(via)) return "";
  for (const entry of via) {
    if (entry && typeof entry === "object") {
      const obj = entry as { title?: string; name?: string };
      if (obj.title) return obj.title;
      if (obj.name) return obj.name;
    }
  }
  // Sometimes `via` entries are just package-name strings
  for (const entry of via) {
    if (typeof entry === "string") return entry;
  }
  return "";
}

function extractNpmPatchedVersion(
  fixAvailable: NpmVuln["fixAvailable"]
): string {
  if (!fixAvailable) return "";
  if (fixAvailable === true) return "available";
  if (typeof fixAvailable === "object" && fixAvailable.version) {
    return fixAvailable.version;
  }
  return "";
}

interface PartialReport {
  manager: "npm" | "pip";
  totalDeps: number;
  vulnerabilities: Vulnerability[];
  summary: VulnerabilitySummary;
  outdated: number;
  warnings: string[];
}

async function analyzeNpm(repoPath: string): Promise<PartialReport | null> {
  const pkgPath = join(repoPath, "package.json");
  if (!(await fileExists(pkgPath))) return null;

  const warnings: string[] = [];
  let totalDeps = 0;
  try {
    const pkgRaw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgRaw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    totalDeps =
      Object.keys(pkg.dependencies ?? {}).length +
      Object.keys(pkg.devDependencies ?? {}).length;
  } catch {
    warnings.push("could not parse package.json");
  }

  const vulnerabilities: Vulnerability[] = [];
  const summary = emptySummary();

  const auditResult = await runCommand("npm audit --json", repoPath);
  if (!auditResult.stdout.trim()) {
    if (isCommandMissing(auditResult)) {
      warnings.push("npm not installed — skipped vulnerability scan");
    } else if (auditResult.stderr) {
      warnings.push(`npm audit failed: ${firstLine(auditResult.stderr)}`);
    }
  } else {
    try {
      const audit = JSON.parse(auditResult.stdout) as NpmAuditOutput;
      const vulns = audit.vulnerabilities ?? {};
      for (const [pkgName, info] of Object.entries(vulns)) {
        const severity = (info.severity ?? "info").toLowerCase();
        bumpSeverity(summary, severity);
        vulnerabilities.push({
          package: pkgName,
          severity,
          current_version: info.range ?? "",
          patched_version: extractNpmPatchedVersion(info.fixAvailable),
          advisory: extractNpmAdvisoryTitle(info.via),
        });
      }
    } catch (err) {
      warnings.push(
        `failed to parse npm audit output: ${(err as Error).message}`
      );
    }
  }

  let outdated = 0;
  const outdatedResult = await runCommand("npm outdated --json", repoPath);
  if (outdatedResult.stdout.trim()) {
    try {
      const parsed = JSON.parse(outdatedResult.stdout) as Record<
        string,
        unknown
      >;
      outdated = Object.keys(parsed).length;
    } catch {
      warnings.push("failed to parse npm outdated output");
    }
  } else if (isCommandMissing(outdatedResult)) {
    // Already warned above for npm-not-installed
  } else if (!outdatedResult.ok && outdatedResult.stderr) {
    // npm outdated prints nothing and exits 0 when everything is current —
    // only warn if we got a real error.
    warnings.push(`npm outdated failed: ${firstLine(outdatedResult.stderr)}`);
  }

  return {
    manager: "npm",
    totalDeps,
    vulnerabilities,
    summary,
    outdated,
    warnings,
  };
}

// ─── pip ──────────────────────────────────────────────────────────────

interface PipAuditDependency {
  name?: string;
  version?: string;
  vulns?: Array<{
    id?: string;
    description?: string;
    fix_versions?: string[];
  }>;
}

async function analyzePip(repoPath: string): Promise<PartialReport | null> {
  const reqPath = join(repoPath, "requirements.txt");
  if (!(await fileExists(reqPath))) return null;

  const warnings: string[] = [];
  let totalDeps = 0;
  try {
    const content = await readFile(reqPath, "utf-8");
    totalDeps = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("-")).length;
  } catch {
    warnings.push("could not read requirements.txt");
  }

  const vulnerabilities: Vulnerability[] = [];
  const summary = emptySummary();

  const auditResult = await runCommand("pip-audit --format json", repoPath);
  if (!auditResult.stdout.trim()) {
    if (isCommandMissing(auditResult)) {
      warnings.push("pip-audit not installed — skipped vulnerability scan");
    } else if (auditResult.stderr) {
      warnings.push(`pip-audit failed: ${firstLine(auditResult.stderr)}`);
    }
  } else {
    try {
      const parsed = JSON.parse(auditResult.stdout) as
        | PipAuditDependency[]
        | { dependencies?: PipAuditDependency[] };
      const deps = Array.isArray(parsed)
        ? parsed
        : (parsed.dependencies ?? []);
      for (const dep of deps) {
        if (!dep.vulns || dep.vulns.length === 0) continue;
        for (const vuln of dep.vulns) {
          // pip-audit doesn't classify severity — bucket as moderate.
          bumpSeverity(summary, "moderate");
          const fix = vuln.fix_versions?.[0] ?? "";
          vulnerabilities.push({
            package: dep.name ?? "",
            severity: "moderate",
            current_version: dep.version ?? "",
            patched_version: fix,
            advisory: vuln.id ?? vuln.description ?? "",
          });
        }
      }
    } catch (err) {
      warnings.push(
        `failed to parse pip-audit output: ${(err as Error).message}`
      );
    }
  }

  let outdated = 0;
  const outdatedResult = await runCommand(
    "pip list --outdated --format json",
    repoPath
  );
  if (outdatedResult.stdout.trim()) {
    try {
      const arr = JSON.parse(outdatedResult.stdout);
      if (Array.isArray(arr)) outdated = arr.length;
    } catch {
      // pip list may print non-JSON warnings on stderr; ignore parse errors
    }
  }

  return {
    manager: "pip",
    totalDeps,
    vulnerabilities,
    summary,
    outdated,
    warnings,
  };
}

function firstLine(s: string): string {
  return s.split("\n")[0].trim();
}

// ─── Combine ──────────────────────────────────────────────────────────

function emptyReport(error?: string): DependencyReport {
  return {
    package_manager: "none",
    total_dependencies: 0,
    vulnerabilities: [],
    outdated_count: 0,
    vulnerability_summary: emptySummary(),
    ...(error ? { error } : {}),
  };
}

function attachWarnings(
  report: DependencyReport,
  warnings: string[]
): DependencyReport {
  if (warnings.length === 0) return report;
  return { ...report, warnings };
}

export async function analyzeDependencies(
  repoPath: string
): Promise<DependencyReport> {
  try {
    return await analyzeDependenciesImpl(repoPath);
  } catch (err) {
    console.error(
      "[sentinel] dependency analysis failed:",
      err instanceof Error ? (err.stack ?? err.message) : err
    );
    return emptyReport(
      `dependency analysis failed: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

async function analyzeDependenciesImpl(
  repoPath: string
): Promise<DependencyReport> {
  const [npm, pip] = await Promise.all([
    analyzeNpm(repoPath),
    analyzePip(repoPath),
  ]);

  if (!npm && !pip) {
    return emptyReport(
      "no recognized package manager — expected package.json or requirements.txt"
    );
  }

  const parts = [npm, pip].filter((p): p is PartialReport => p !== null);
  const combinedSummary = emptySummary();
  let totalDeps = 0;
  let outdated = 0;
  const vulnerabilities: Vulnerability[] = [];
  const warnings: string[] = [];
  for (const part of parts) {
    totalDeps += part.totalDeps;
    outdated += part.outdated;
    vulnerabilities.push(...part.vulnerabilities);
    combinedSummary.critical += part.summary.critical;
    combinedSummary.high += part.summary.high;
    combinedSummary.moderate += part.summary.moderate;
    combinedSummary.low += part.summary.low;
    warnings.push(...part.warnings);
  }

  const manager: DependencyReport["package_manager"] =
    npm && pip ? "npm+pip" : npm ? "npm" : "pip";

  return attachWarnings(
    {
      package_manager: manager,
      total_dependencies: totalDeps,
      vulnerabilities,
      outdated_count: outdated,
      vulnerability_summary: combinedSummary,
    },
    warnings
  );
}
