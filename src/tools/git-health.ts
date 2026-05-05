/**
 * git_health tool handler — Phase 3
 */

import {
  analyzeGitHealth,
  type GitHealthReport,
} from "../analyzers/git-analyzer.js";

export interface GitHealthInput {
  repo_path: string;
  days?: number;
}

export async function handleGitHealth(
  input: GitHealthInput
): Promise<GitHealthReport> {
  return analyzeGitHealth(input.repo_path, { days: input.days });
}
