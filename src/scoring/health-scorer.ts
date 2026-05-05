/**
 * Health Scorer — Phase 5
 *
 * Pure scoring layer. Takes raw analyzer outputs (or null for failed runs)
 * and produces a 0-100 weighted aggregate, letter grade, per-category
 * breakdown, and top-5 actionable recommendations.
 *
 * Weights: complexity 30%, dependencies 25%, git_health 20%,
 *          dead_code 15%, file_size 10%
 */

import type { ComplexityReport } from "../analyzers/ast-analyzer.js";
import type { DependencyReport } from "../analyzers/dependency-analyzer.js";
import type { GitHealthReport } from "../analyzers/git-analyzer.js";
import type { DeadCodeReport } from "../analyzers/dead-code-analyzer.js";
import type { FileAnalysisResult } from "../analyzers/file-analyzer.js";

// ─── Public types ────────────────────────────────────────────────────

export const WEIGHTS = {
  complexity: 0.3,
  dependencies: 0.25,
  git_health: 0.2,
  dead_code: 0.15,
  file_size: 0.1,
} as const;

export type CategoryName = keyof typeof WEIGHTS;

export interface CategoryBreakdown {
  score: number | null;
  weight: number;
  summary: string;
  error?: string;
}

export interface HealthReport {
  score: number;
  grade: string;
  breakdown: Record<CategoryName, CategoryBreakdown>;
  top_recommendations: string[];
}

export interface AnalyzerInput<T> {
  result?: T;
  error?: string;
}

export interface ScorerInputs {
  complexity: AnalyzerInput<ComplexityReport>;
  dependencies: AnalyzerInput<DependencyReport>;
  git_health: AnalyzerInput<GitHealthReport>;
  dead_code: AnalyzerInput<DeadCodeReport>;
  file_size: AnalyzerInput<FileAnalysisResult>;
}

// ─── Letter grade ────────────────────────────────────────────────────

export function letterGrade(score: number): string {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
  return "F";
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

// ─── Per-category scoring ────────────────────────────────────────────

function scoreComplexity(r: ComplexityReport): { score: number; summary: string } {
  const high = r.distribution.high;
  const critical = r.distribution.critical;
  const score = clamp(100 - high * 5 - critical * 10);
  const flagged = high + critical;
  const summary =
    flagged === 0
      ? `${r.total_functions} functions, all under threshold`
      : `${flagged} high-complexity function${flagged === 1 ? "" : "s"}` +
        (critical > 0 ? ` (${critical} critical)` : "");
  return { score, summary };
}

function scoreDependencies(
  r: DependencyReport
): { score: number; summary: string } {
  const s = r.vulnerability_summary;
  const score = clamp(
    100 - s.critical * 15 - s.high * 10 - s.moderate * 5 - s.low * 2
  );
  const total = s.critical + s.high + s.moderate + s.low;
  let summary: string;
  if (total === 0) {
    summary = `${r.total_dependencies} dependencies, no known vulnerabilities`;
  } else {
    const parts: string[] = [];
    if (s.critical > 0) parts.push(`${s.critical} critical`);
    if (s.high > 0) parts.push(`${s.high} high`);
    if (s.moderate > 0) parts.push(`${s.moderate} moderate`);
    if (s.low > 0) parts.push(`${s.low} low`);
    summary = `${parts.join(", ")} ${total === 1 ? "vulnerability" : "vulnerabilities"}`;
  }
  return { score, summary };
}

function scoreGitHealth(r: GitHealthReport): { score: number; summary: string } {
  const bus = r.bus_factor;
  const busBase = bus <= 1 ? 40 : bus === 2 ? 65 : bus === 3 ? 80 : 95;
  let score = busBase;
  score -= r.stale_branches.length * 2;
  if (r.commit_frequency.last_90_days >= 30) score += 5;
  return {
    score: clamp(score),
    summary: `Bus factor of ${bus}, ${r.commit_frequency.last_90_days} commits in last 90 days`,
  };
}

function scoreDeadCode(r: DeadCodeReport): { score: number; summary: string } {
  const score = clamp(100 - r.unused_percentage * 2);
  const summary =
    r.unused_count === 0
      ? "no unused exports detected"
      : `${r.unused_count} unused export${r.unused_count === 1 ? "" : "s"} (${r.unused_percentage}%)`;
  return { score, summary };
}

function scoreFileSize(
  r: FileAnalysisResult
): { score: number; summary: string } {
  const over = r.files_over_threshold;
  const score = clamp(100 - over * 3);
  const summary =
    over === 0
      ? `${r.total_files_scanned} files, all under threshold`
      : `${over} file${over === 1 ? "" : "s"} over threshold`;
  return { score, summary };
}

// ─── Recommendation generation ───────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  moderate: 2,
  low: 3,
  info: 4,
};

function complexityRecs(r: ComplexityReport): string[] {
  return r.high_complexity_functions
    .slice(0, 3)
    .map(
      (fn) =>
        `Refactor ${fn.function_name} (complexity: ${fn.complexity}) in ${fn.file}`
    );
}

function depRecs(r: DependencyReport): string[] {
  return [...r.vulnerabilities]
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
    )
    .slice(0, 3)
    .map((v) => {
      const advisory = v.advisory ? ` (${v.advisory})` : "";
      const fix = v.patched_version
        ? ` — fix in ${v.patched_version}`
        : "";
      return `Update ${v.package} to address ${v.severity}-severity vulnerability${advisory}${fix}`;
    });
}

function gitRecs(r: GitHealthReport): string[] {
  const recs: string[] = [];
  if (r.bus_factor > 0 && r.bus_factor <= 2 && r.contributor_concentration[0]) {
    const top = r.contributor_concentration[0];
    recs.push(
      `Increase contributor diversity — ${top.percentage}% of commits from ${top.author}`
    );
  }
  if (r.stale_branches.length >= 3) {
    recs.push(
      `Clean up ${r.stale_branches.length} stale branches (no commits in 30+ days)`
    );
  }
  if (r.largest_single_author_files.length > 0) {
    const f = r.largest_single_author_files[0];
    recs.push(
      `Spread ownership of ${f.file} (${f.ownership_percentage}% authored by ${f.author})`
    );
  }
  return recs;
}

function deadCodeRecs(r: DeadCodeReport): string[] {
  if (r.unused_count === 0) return [];
  return [
    `Remove ${r.unused_count} unused export${r.unused_count === 1 ? "" : "s"} to reduce dead code surface`,
  ];
}

function fileSizeRecs(r: FileAnalysisResult): string[] {
  return r.large_files
    .slice(0, 3)
    .map(
      (f) => `Split ${f.file} (${f.lines} lines) into smaller modules`
    );
}

function buildRecommendations(
  inputs: ScorerInputs,
  breakdown: Record<CategoryName, CategoryBreakdown>
): string[] {
  // Bucket recommendations by category, then walk worst-scoring categories first.
  const byCategory: Record<CategoryName, string[]> = {
    complexity: inputs.complexity.result
      ? complexityRecs(inputs.complexity.result)
      : [],
    dependencies: inputs.dependencies.result
      ? depRecs(inputs.dependencies.result)
      : [],
    git_health: inputs.git_health.result
      ? gitRecs(inputs.git_health.result)
      : [],
    dead_code: inputs.dead_code.result
      ? deadCodeRecs(inputs.dead_code.result)
      : [],
    file_size: inputs.file_size.result
      ? fileSizeRecs(inputs.file_size.result)
      : [],
  };

  const order: CategoryName[] = (
    Object.keys(byCategory) as CategoryName[]
  ).sort((a, b) => {
    const sa = breakdown[a].score ?? 101;
    const sb = breakdown[b].score ?? 101;
    return sa - sb;
  });

  // Round-robin through worst → best so we get diversity if any single
  // category has more than 5 candidates.
  const out: string[] = [];
  let added = true;
  while (added && out.length < 5) {
    added = false;
    for (const cat of order) {
      if (out.length >= 5) break;
      const next = byCategory[cat].shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

// ─── Aggregation ─────────────────────────────────────────────────────

function buildBreakdown(inputs: ScorerInputs): Record<CategoryName, CategoryBreakdown> {
  const breakdown: Record<CategoryName, CategoryBreakdown> = {
    complexity: { score: null, weight: WEIGHTS.complexity, summary: "" },
    dependencies: { score: null, weight: WEIGHTS.dependencies, summary: "" },
    git_health: { score: null, weight: WEIGHTS.git_health, summary: "" },
    dead_code: { score: null, weight: WEIGHTS.dead_code, summary: "" },
    file_size: { score: null, weight: WEIGHTS.file_size, summary: "" },
  };

  if (inputs.complexity.result) {
    const { score, summary } = scoreComplexity(inputs.complexity.result);
    breakdown.complexity.score = score;
    breakdown.complexity.summary = summary;
  } else {
    breakdown.complexity.summary = "complexity analysis unavailable";
    breakdown.complexity.error = inputs.complexity.error;
  }

  if (inputs.dependencies.result && !inputs.dependencies.result.error) {
    const { score, summary } = scoreDependencies(inputs.dependencies.result);
    breakdown.dependencies.score = score;
    breakdown.dependencies.summary = summary;
  } else {
    breakdown.dependencies.summary = "dependency analysis unavailable";
    breakdown.dependencies.error =
      inputs.dependencies.error ?? inputs.dependencies.result?.error;
  }

  if (inputs.git_health.result && !inputs.git_health.result.error) {
    const { score, summary } = scoreGitHealth(inputs.git_health.result);
    breakdown.git_health.score = score;
    breakdown.git_health.summary = summary;
  } else {
    breakdown.git_health.summary = "git analysis unavailable";
    breakdown.git_health.error =
      inputs.git_health.error ?? inputs.git_health.result?.error;
  }

  if (inputs.dead_code.result) {
    const { score, summary } = scoreDeadCode(inputs.dead_code.result);
    breakdown.dead_code.score = score;
    breakdown.dead_code.summary = summary;
  } else {
    breakdown.dead_code.summary = "dead code analysis unavailable";
    breakdown.dead_code.error = inputs.dead_code.error;
  }

  if (inputs.file_size.result) {
    const { score, summary } = scoreFileSize(inputs.file_size.result);
    breakdown.file_size.score = score;
    breakdown.file_size.summary = summary;
  } else {
    breakdown.file_size.summary = "file size analysis unavailable";
    breakdown.file_size.error = inputs.file_size.error;
  }

  return breakdown;
}

function aggregateScore(
  breakdown: Record<CategoryName, CategoryBreakdown>
): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const cat of Object.keys(breakdown) as CategoryName[]) {
    const c = breakdown[cat];
    if (c.score === null) continue;
    weightedSum += c.score * c.weight;
    totalWeight += c.weight;
  }
  if (totalWeight === 0) return 0;
  return Math.round(weightedSum / totalWeight);
}

export function computeHealthScore(inputs: ScorerInputs): HealthReport {
  const breakdown = buildBreakdown(inputs);
  const score = aggregateScore(breakdown);
  const recommendations = buildRecommendations(inputs, breakdown);
  return {
    score,
    grade: letterGrade(score),
    breakdown,
    top_recommendations: recommendations,
  };
}
