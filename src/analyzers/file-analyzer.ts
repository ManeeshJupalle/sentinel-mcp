/**
 * File size and line count analyzer.
 * Used by find_large_files tool and the health report aggregator.
 */

import { walkRepo, countLines } from "../utils/file-walker.js";

export interface LargeFileResult {
  file: string;
  lines: number;
  size_bytes: number;
}

export interface FileAnalysisResult {
  large_files: LargeFileResult[];
  total_files_scanned: number;
  files_over_threshold: number;
}

function emptyFileAnalysisResult(): FileAnalysisResult {
  return {
    large_files: [],
    total_files_scanned: 0,
    files_over_threshold: 0,
  };
}

export async function analyzeFiles(
  repoPath: string,
  options: {
    threshold?: number;
    limit?: number;
    pathFilter?: string;
  } = {}
): Promise<FileAnalysisResult> {
  try {
    return await analyzeFilesImpl(repoPath, options);
  } catch (err) {
    console.error(
      "[sentinel] file size analysis failed:",
      err instanceof Error ? err.message : err
    );
    return emptyFileAnalysisResult();
  }
}

async function analyzeFilesImpl(
  repoPath: string,
  options: {
    threshold?: number;
    limit?: number;
    pathFilter?: string;
  }
): Promise<FileAnalysisResult> {
  const threshold = options.threshold ?? 300;
  const limit = options.limit ?? 20;

  const files = await walkRepo(repoPath, {
    sourceOnly: true,
    pathFilter: options.pathFilter,
  });

  const fileMetrics: LargeFileResult[] = [];

  for (const file of files) {
    const lines = await countLines(file.absolutePath);
    if (lines >= threshold) {
      fileMetrics.push({
        file: file.relativePath,
        lines,
        size_bytes: file.sizeBytes,
      });
    }
  }

  // Sort by line count descending
  fileMetrics.sort((a, b) => b.lines - a.lines);

  return {
    large_files: fileMetrics.slice(0, limit),
    total_files_scanned: files.length,
    files_over_threshold: fileMetrics.length,
  };
}
