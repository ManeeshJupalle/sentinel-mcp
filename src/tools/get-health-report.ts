/**
 * get_health_report tool handler — Phase 5
 *
 * Runs all five analyzers concurrently with Promise.allSettled so a single
 * analyzer failure cannot crash the whole report. Failed analyzers are
 * reflected as a null score in their breakdown entry along with an error
 * note; the aggregate is computed from the remaining categories.
 */

import { analyzeComplexity } from "../analyzers/ast-analyzer.js";
import { analyzeDependencies } from "../analyzers/dependency-analyzer.js";
import { analyzeGitHealth } from "../analyzers/git-analyzer.js";
import { analyzeDeadCode } from "../analyzers/dead-code-analyzer.js";
import { analyzeFiles } from "../analyzers/file-analyzer.js";
import {
  computeHealthScore,
  type HealthReport,
  type AnalyzerInput,
} from "../scoring/health-scorer.js";

export interface GetHealthReportInput {
  repo_path: string;
}

function settledToInput<T>(
  settled: PromiseSettledResult<T>
): AnalyzerInput<T> {
  if (settled.status === "fulfilled") {
    return { result: settled.value };
  }
  const reason = settled.reason;
  const message =
    reason instanceof Error ? reason.message : String(reason ?? "unknown error");
  return { error: message };
}

export async function handleGetHealthReport(
  input: GetHealthReportInput
): Promise<HealthReport> {
  const repoPath = input.repo_path;

  const [complexity, dependencies, git, deadCode, fileSize] =
    await Promise.allSettled([
      analyzeComplexity(repoPath),
      analyzeDependencies(repoPath),
      analyzeGitHealth(repoPath),
      analyzeDeadCode(repoPath),
      analyzeFiles(repoPath),
    ]);

  return computeHealthScore({
    complexity: settledToInput(complexity),
    dependencies: settledToInput(dependencies),
    git_health: settledToInput(git),
    dead_code: settledToInput(deadCode),
    file_size: settledToInput(fileSize),
  });
}
