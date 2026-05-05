/**
 * check_dependencies tool handler — Phase 3
 */

import {
  analyzeDependencies,
  type DependencyReport,
} from "../analyzers/dependency-analyzer.js";

export interface CheckDependenciesInput {
  repo_path: string;
}

export async function handleCheckDependencies(
  input: CheckDependenciesInput
): Promise<DependencyReport> {
  return analyzeDependencies(input.repo_path);
}
