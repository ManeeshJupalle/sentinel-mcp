#!/usr/bin/env node

/**
 * Sentinel MCP Server
 *
 * A lightweight, zero-config MCP server for codebase health analysis.
 * Exposes tools for complexity analysis, dependency auditing, dead code
 * detection, git health scoring, and aggregate health reporting.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { handleFindLargeFiles } from "./tools/find-large-files.js";
import { handleAnalyzeComplexity } from "./tools/analyze-complexity.js";
import { handleGitHealth } from "./tools/git-health.js";
import { handleCheckDependencies } from "./tools/check-dependencies.js";
import { handleDetectDeadCode } from "./tools/detect-dead-code.js";
import { handleGetHealthReport } from "./tools/get-health-report.js";

function getVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Handle --version / -v before we spin up the server
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--version") || cliArgs.includes("-v")) {
  console.log(getVersion());
  process.exit(0);
}

// Parse --repo argument from CLI
function getRepoPath(): string {
  const repoIndex = cliArgs.indexOf("--repo");
  if (repoIndex !== -1 && cliArgs[repoIndex + 1]) {
    return cliArgs[repoIndex + 1];
  }
  return process.cwd();
}

const DEFAULT_REPO_PATH = getRepoPath();
const SERVER_VERSION = getVersion();

// Create the MCP server
const server = new McpServer({
  name: "sentinel-mcp",
  version: SERVER_VERSION,
});

// ─── Tool: find_large_files ───────────────────────────────────────────
server.tool(
  "find_large_files",
  "Walk the repository and report source files exceeding a line count threshold. " +
    "Useful for identifying files that are candidates for refactoring or splitting. " +
    "Respects .gitignore patterns and only scans source code files (JS/TS/Python).",
  {
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the repository root directory"),
    threshold: z
      .number()
      .optional()
      .describe("Minimum line count to flag a file as large (default: 300)"),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 20)"),
  },
  async (params) => {
    try {
      const result = await handleFindLargeFiles({
        repo_path: params.repo_path || DEFAULT_REPO_PATH,
        threshold: params.threshold,
        limit: params.limit,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: analyze_complexity (Phase 2) ───────────────────────────────
server.tool(
  "analyze_complexity",
  "Analyze cyclomatic complexity of functions in the codebase using AST parsing. " +
    "Returns a sorted list of the most complex functions with file, line number, " +
    "function name, and complexity score.",
  {
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the repository root directory"),
    path_filter: z
      .string()
      .optional()
      .describe("Relative path to scope the analysis to a subdirectory or file"),
    threshold: z
      .number()
      .optional()
      .describe("Minimum complexity score to include in results (default: 10)"),
  },
  async (params) => {
    try {
      const result = await handleAnalyzeComplexity({
        repo_path: params.repo_path || DEFAULT_REPO_PATH,
        path_filter: params.path_filter,
        threshold: params.threshold,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: check_dependencies (Phase 3) ──────────────────────────────
server.tool(
  "check_dependencies",
  "Detect the package manager and run dependency audits. " +
    "Returns vulnerabilities, outdated packages, and a security summary.",
  {
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the repository root directory"),
  },
  async (params) => {
    try {
      const result = await handleCheckDependencies({
        repo_path: params.repo_path || DEFAULT_REPO_PATH,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: detect_dead_code (Phase 4) ────────────────────────────────
server.tool(
  "detect_dead_code",
  "Build an export/import graph and find exported symbols that are never imported. " +
    "Helps identify code that can be safely removed.",
  {
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the repository root directory"),
    path_filter: z
      .string()
      .optional()
      .describe("Relative path to scope the analysis"),
  },
  async (params) => {
    try {
      const result = await handleDetectDeadCode({
        repo_path: params.repo_path || DEFAULT_REPO_PATH,
        path_filter: params.path_filter,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: git_health (Phase 3) ──────────────────────────────────────
server.tool(
  "git_health",
  "Analyze git history to surface commit velocity, bus factor, contributor " +
    "concentration, stale branches, and single-author file ownership.",
  {
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the repository root directory"),
    days: z
      .number()
      .optional()
      .describe("Lookback period in days for commit analysis (default: 90)"),
  },
  async (params) => {
    try {
      const result = await handleGitHealth({
        repo_path: params.repo_path || DEFAULT_REPO_PATH,
        days: params.days,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: get_health_report (Phase 5) ───────────────────────────────
server.tool(
  "get_health_report",
  "Run all analyzers and produce an aggregate health score (0-100) with a " +
    "letter grade, category breakdown, and top 5 prioritized recommendations.",
  {
    repo_path: z
      .string()
      .optional()
      .describe("Absolute path to the repository root directory"),
  },
  async (params) => {
    try {
      const result = await handleGetHealthReport({
        repo_path: params.repo_path || DEFAULT_REPO_PATH,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Start the server ────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Sentinel MCP server running (repo: ${DEFAULT_REPO_PATH})`);
}

main().catch((error) => {
  console.error("Fatal error starting Sentinel MCP server:", error);
  process.exit(1);
});
