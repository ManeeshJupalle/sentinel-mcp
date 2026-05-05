/**
 * analyze_complexity tool handler — Phase 2
 *
 * Parses source files into ASTs using Tree-sitter, walks function nodes,
 * and computes cyclomatic complexity per function.
 */

import {
  analyzeComplexity,
  type ComplexityReport,
} from "../analyzers/ast-analyzer.js";

export interface AnalyzeComplexityInput {
  repo_path: string;
  path_filter?: string;
  threshold?: number;
}

export async function handleAnalyzeComplexity(
  input: AnalyzeComplexityInput
): Promise<ComplexityReport> {
  return analyzeComplexity(input.repo_path, {
    pathFilter: input.path_filter,
    threshold: input.threshold,
  });
}
