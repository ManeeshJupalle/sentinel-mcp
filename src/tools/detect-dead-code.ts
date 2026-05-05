/**
 * detect_dead_code tool handler — Phase 4
 */

import {
  analyzeDeadCode,
  type DeadCodeReport,
} from "../analyzers/dead-code-analyzer.js";

export interface DetectDeadCodeInput {
  repo_path: string;
  path_filter?: string;
}

export async function handleDetectDeadCode(
  input: DetectDeadCodeInput
): Promise<DeadCodeReport> {
  return analyzeDeadCode(input.repo_path, { pathFilter: input.path_filter });
}
