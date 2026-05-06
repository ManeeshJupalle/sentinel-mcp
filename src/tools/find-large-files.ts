/**
 * find_large_files tool handler.
 * Walks the repository and reports files exceeding a configurable line count threshold.
 */

import { analyzeFiles, type FileAnalysisResult } from "../analyzers/file-analyzer.js";

export interface FindLargeFilesInput {
  repo_path: string;
  threshold?: number;
  limit?: number;
}

export async function handleFindLargeFiles(
  input: FindLargeFilesInput
): Promise<FileAnalysisResult> {
  return analyzeFiles(input.repo_path, {
    threshold: input.threshold,
    limit: input.limit,
  });
}
