/**
 * Recursive file walker that respects .gitignore patterns.
 * Returns source code files for analysis, skipping binary files,
 * node_modules, and other non-relevant directories.
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import ignore, { type Ignore } from "ignore";
import { isSourceFile, shouldIgnoreDirectory } from "./language-detect.js";

export interface FileEntry {
  /** Absolute path to the file */
  absolutePath: string;
  /** Path relative to the repository root */
  relativePath: string;
  /** File size in bytes */
  sizeBytes: number;
}

export interface WalkOptions {
  /** Only return files matching source code extensions */
  sourceOnly?: boolean;
  /** Optional subdirectory or file path filter (relative to repo root) */
  pathFilter?: string;
}

/**
 * Loads and parses .gitignore from the repo root.
 * Returns an `ignore` instance for pattern matching.
 */
async function loadGitignore(repoPath: string): Promise<Ignore> {
  const ig = ignore();

  try {
    const gitignorePath = join(repoPath, ".gitignore");
    const content = await readFile(gitignorePath, "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore found — that's fine
  }

  return ig;
}

/**
 * Recursively walks a directory, yielding FileEntry objects.
 * Respects .gitignore patterns and skips known non-source directories.
 */
async function* walkDirectory(
  dirPath: string,
  repoRoot: string,
  ig: Ignore,
  options: WalkOptions
): AsyncGenerator<FileEntry> {
  let entries;

  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    // Permission denied or other read error — skip
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const relPath = relative(repoRoot, fullPath);

    // Skip always-ignored directories
    if (entry.isDirectory() && shouldIgnoreDirectory(entry.name)) {
      continue;
    }

    // Skip .gitignore'd paths
    if (ig.ignores(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      yield* walkDirectory(fullPath, repoRoot, ig, options);
    } else if (entry.isFile()) {
      // If sourceOnly, skip non-source files
      if (options.sourceOnly && !isSourceFile(entry.name)) {
        continue;
      }

      try {
        const fileStat = await stat(fullPath);
        yield {
          absolutePath: fullPath,
          relativePath: relPath,
          sizeBytes: fileStat.size,
        };
      } catch {
        // Can't stat file — skip
        continue;
      }
    }
  }
}

/**
 * Main entry point: walks a repository and returns all matching files.
 */
export async function walkRepo(
  repoPath: string,
  options: WalkOptions = {}
): Promise<FileEntry[]> {
  const ig = await loadGitignore(repoPath);

  // Resolve pathFilter and refuse anything that escapes the repo root.
  // Without this, `path_filter: ".."` would walk the whole filesystem
  // and downstream consumers (`ignore.ignores("")`) can throw.
  let startPath = repoPath;
  if (options.pathFilter) {
    const candidate = isAbsolute(options.pathFilter)
      ? resolve(options.pathFilter)
      : resolve(repoPath, options.pathFilter);
    const rel = relative(repoPath, candidate);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return []; // path_filter escapes the repo
    }
    startPath = candidate;
  }

  // Check if pathFilter points to a single file
  try {
    const startStat = await stat(startPath);
    if (startStat.isFile()) {
      const relPath = relative(repoPath, startPath);
      if (options.sourceOnly && !isSourceFile(startPath)) {
        return [];
      }
      return [
        {
          absolutePath: startPath,
          relativePath: relPath,
          sizeBytes: startStat.size,
        },
      ];
    }
  } catch {
    // Path doesn't exist
    return [];
  }

  const files: FileEntry[] = [];
  for await (const file of walkDirectory(startPath, repoPath, ig, options)) {
    files.push(file);
  }

  return files;
}

/**
 * Counts lines in a file. An empty file is 0 lines. A trailing newline does
 * not count as an extra line, so "a\nb\n" reports 2.
 * Returns 0 for binary or unreadable files.
 */
export async function countLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, "utf-8");
    if (content.length === 0) return 0;
    if (content.includes("\0")) return 0; // binary
    let count = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) count++;
    }
    if (!content.endsWith("\n")) count++;
    return count;
  } catch {
    return 0;
  }
}
