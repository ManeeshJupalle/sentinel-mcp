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

/** JSON Schema for MCP tool registration */
export const findLargeFilesSchema = {
  name: "find_large_files",
  description:
    "Walk the repository and report source files exceeding a line count threshold. " +
    "Useful for identifying files that are candidates for refactoring or splitting. " +
    "Respects .gitignore patterns and only scans source code files (JS/TS/Python).",
  inputSchema: {
    type: "object" as const,
    properties: {
      repo_path: {
        type: "string",
        description: "Absolute path to the repository root directory",
      },
      threshold: {
        type: "number",
        description:
          "Minimum line count to flag a file as large (default: 300)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 20)",
      },
    },
    required: ["repo_path"],
  },
};
