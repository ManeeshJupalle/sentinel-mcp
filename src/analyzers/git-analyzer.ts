/**
 * Git Analyzer — Phase 3
 *
 * Mines repository history via simple-git for health signals: commit
 * velocity, bus factor, contributor concentration, stale branches, and
 * single-author file ownership.
 */

import { simpleGit, type SimpleGit } from "simple-git";
import { isSourceFile } from "../utils/language-detect.js";

const STALE_DAYS = 30;
const OWNERSHIP_THRESHOLD = 0.9;
const BUS_FACTOR_THRESHOLD = 0.8;
const MS_PER_DAY = 86400 * 1000;

export interface ContributorShare {
  author: string;
  percentage: number;
}

export interface StaleBranch {
  name: string;
  last_commit: string;
  days_stale: number;
}

export interface AuthorOwnedFile {
  file: string;
  author: string;
  ownership_percentage: number;
}

export interface GitHealthReport {
  commit_frequency: { last_30_days: number; last_90_days: number };
  bus_factor: number;
  contributor_concentration: ContributorShare[];
  stale_branches: StaleBranch[];
  largest_single_author_files: AuthorOwnedFile[];
  error?: string;
}

function emptyReport(error?: string): GitHealthReport {
  return {
    commit_frequency: { last_30_days: 0, last_90_days: 0 },
    bus_factor: 0,
    contributor_concentration: [],
    stale_branches: [],
    largest_single_author_files: [],
    ...(error ? { error } : {}),
  };
}

async function commitCountSinceDays(git: SimpleGit, days: number): Promise<number> {
  try {
    const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();
    const out = await git.raw([
      "rev-list",
      "--count",
      "--all",
      "--no-merges",
      `--since=${since}`,
    ]);
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function authorCountsForWindow(
  git: SimpleGit,
  days: number
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();
    const out = await git.raw([
      "log",
      "--all",
      "--no-merges",
      `--since=${since}`,
      "--pretty=format:%an",
    ]);
    if (!out.trim()) return counts;
    for (const line of out.split("\n")) {
      const author = line.trim();
      if (!author) continue;
      counts.set(author, (counts.get(author) ?? 0) + 1);
    }
  } catch {
    // empty repo or other failure — return empty map
  }
  return counts;
}

function computeBusFactor(counts: Map<string, number>): number {
  const sorted = Array.from(counts.values()).sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  let cumulative = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i];
    if (cumulative / total >= BUS_FACTOR_THRESHOLD) return i + 1;
  }
  return sorted.length;
}

function topContributors(
  counts: Map<string, number>,
  limit = 5
): ContributorShare[] {
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([author, count]) => ({
      author,
      percentage: Math.round((count / total) * 100),
    }));
}

async function findStaleBranches(git: SimpleGit): Promise<StaleBranch[]> {
  let out: string;
  try {
    out = await git.raw([
      "for-each-ref",
      "--format=%(refname:short)\t%(committerdate:iso8601)",
      "refs/heads/",
      "refs/remotes/",
    ]);
  } catch {
    return [];
  }

  const stale: StaleBranch[] = [];
  const seen = new Set<string>();
  const now = Date.now();

  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const name = line.slice(0, tab).trim();
    const dateStr = line.slice(tab + 1).trim();
    if (!name || !dateStr) continue;
    if (name === "HEAD" || name.endsWith("/HEAD")) continue;

    // Dedupe local + remote tracking branches by their short name
    const normalized = name.replace(/^[^/]+\//, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const lastCommit = new Date(dateStr);
    if (Number.isNaN(lastCommit.getTime())) continue;
    const daysStale = Math.floor((now - lastCommit.getTime()) / MS_PER_DAY);
    if (daysStale >= STALE_DAYS) {
      stale.push({
        name,
        last_commit: lastCommit.toISOString().slice(0, 10),
        days_stale: daysStale,
      });
    }
  }

  return stale.sort((a, b) => b.days_stale - a.days_stale);
}

/**
 * Walk the entire git log once and tally per-file author commit counts.
 * `git log --no-merges --format='COMMIT <author>' --name-only` produces
 * blocks of one author header followed by the files touched in that commit.
 */
async function findAuthorOwnedFiles(git: SimpleGit): Promise<AuthorOwnedFile[]> {
  let out: string;
  try {
    out = await git.raw([
      "log",
      "--all",
      "--no-merges",
      "--format=COMMIT %an",
      "--name-only",
    ]);
  } catch {
    return [];
  }

  const fileAuthors = new Map<string, Map<string, number>>();
  let currentAuthor: string | null = null;

  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("COMMIT ")) {
      currentAuthor = line.slice(7).trim() || null;
      continue;
    }
    if (!currentAuthor) continue;
    if (!isSourceFile(line)) continue;
    let counts = fileAuthors.get(line);
    if (!counts) {
      counts = new Map();
      fileAuthors.set(line, counts);
    }
    counts.set(currentAuthor, (counts.get(currentAuthor) ?? 0) + 1);
  }

  const results: AuthorOwnedFile[] = [];
  for (const [file, counts] of fileAuthors) {
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    if (total < 3) continue; // skip files with too few commits to be meaningful
    let topAuthor = "";
    let topCount = 0;
    for (const [author, count] of counts) {
      if (count > topCount) {
        topAuthor = author;
        topCount = count;
      }
    }
    const ownership = topCount / total;
    if (ownership >= OWNERSHIP_THRESHOLD) {
      results.push({
        file,
        author: topAuthor,
        ownership_percentage: Math.round(ownership * 100),
      });
    }
  }

  return results
    .sort((a, b) => b.ownership_percentage - a.ownership_percentage)
    .slice(0, 20);
}

export async function analyzeGitHealth(
  repoPath: string,
  options: { days?: number } = {}
): Promise<GitHealthReport> {
  try {
    return await analyzeGitHealthImpl(repoPath, options);
  } catch (err) {
    console.error(
      "[sentinel] git analysis failed:",
      err instanceof Error ? err.message : err
    );
    return emptyReport(
      `git analysis failed: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }
}

async function analyzeGitHealthImpl(
  repoPath: string,
  options: { days?: number }
): Promise<GitHealthReport> {
  let git: SimpleGit;
  try {
    git = simpleGit(repoPath);
  } catch (err) {
    return emptyReport(
      `failed to initialize git: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  let isRepo: boolean;
  try {
    isRepo = await git.checkIsRepo();
  } catch {
    return emptyReport("not a git repository");
  }
  if (!isRepo) return emptyReport("not a git repository");

  const lookbackDays = options.days ?? 90;

  const [last30, last90, contributorCounts, stale, ownedFiles] =
    await Promise.all([
      commitCountSinceDays(git, 30),
      commitCountSinceDays(git, 90),
      authorCountsForWindow(git, lookbackDays),
      findStaleBranches(git),
      findAuthorOwnedFiles(git),
    ]);

  if (contributorCounts.size === 0 && last90 === 0) {
    return emptyReport("repository has no commit history");
  }

  return {
    commit_frequency: { last_30_days: last30, last_90_days: last90 },
    bus_factor: computeBusFactor(contributorCounts),
    contributor_concentration: topContributors(contributorCounts),
    stale_branches: stale,
    largest_single_author_files: ownedFiles,
  };
}
