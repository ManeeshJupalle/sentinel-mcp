# Sentinel MCP

A lightweight, zero-config MCP server that gives AI agents instant codebase health analysis. Point it at any local repository and get complexity metrics, dependency audits, dead code detection, git health scores, and a prioritized health report — all computed on-device with no external databases or cloud dependencies.

```bash
npx sentinel-mcp --repo /path/to/your/project
```

## Why Sentinel?

Every engineering team deals with technical debt, but measuring it requires heavy tools with complex setup. Sentinel changes that:

- **Zero config** — no databases, no cloud accounts, no API keys
- **Zero dependencies on external services** — everything runs locally
- **Works with any MCP client** — Claude Desktop, Cursor, Windsurf, Claude Code
- **Multi-language** — TypeScript/JavaScript and Python out of the box, extensible to more
- **Fast** — on-demand analysis, no background indexing

## MCP Tools

Sentinel exposes 6 tools to AI agents:

### `analyze_complexity`
Parses source files into ASTs using Tree-sitter, walks function nodes, and computes cyclomatic complexity per function.

**Input Schema:**
```json
{
  "repo_path": "string (required) — absolute path to the repository root",
  "path_filter": "string (optional) — relative path to a subdirectory or specific file",
  "threshold": "number (optional, default: 10) — minimum complexity score to include in results"
}
```

**Output:**
```json
{
  "files_analyzed": 42,
  "total_functions": 186,
  "high_complexity_functions": [
    {
      "file": "src/utils/parser.ts",
      "function_name": "parseExpression",
      "line": 45,
      "complexity": 18,
      "severity": "high"
    }
  ],
  "average_complexity": 4.2,
  "distribution": { "low": 150, "moderate": 28, "high": 6, "critical": 2 }
}
```

### `check_dependencies`
Detects the package manager (npm or pip), runs the appropriate audit command, and parses the structured output.

**Input Schema:**
```json
{
  "repo_path": "string (required) — absolute path to the repository root"
}
```

**Output:**
```json
{
  "package_manager": "npm",
  "total_dependencies": 45,
  "vulnerabilities": [
    {
      "package": "lodash",
      "severity": "high",
      "current_version": "4.17.15",
      "patched_version": "4.17.21",
      "advisory": "Prototype Pollution"
    }
  ],
  "outdated_count": 12,
  "vulnerability_summary": { "critical": 0, "high": 1, "moderate": 3, "low": 2 }
}
```

### `detect_dead_code`
Builds an export/import graph across the codebase and finds exported symbols that are never imported elsewhere.

**Input Schema:**
```json
{
  "repo_path": "string (required) — absolute path to the repository root",
  "path_filter": "string (optional) — relative path to scope the analysis"
}
```

**Output:**
```json
{
  "potentially_dead_exports": [
    {
      "file": "src/helpers/format.ts",
      "symbol": "formatLegacyDate",
      "line": 23,
      "type": "function"
    }
  ],
  "total_exports": 89,
  "unused_count": 7,
  "unused_percentage": 7.9
}
```

### `git_health`
Analyzes git history to surface contributor concentration, commit velocity, and stale branches.

**Input Schema:**
```json
{
  "repo_path": "string (required) — absolute path to the repository root",
  "days": "number (optional, default: 90) — lookback period for commit analysis"
}
```

**Output:**
```json
{
  "commit_frequency": { "last_30_days": 48, "last_90_days": 142 },
  "bus_factor": 2,
  "contributor_concentration": [
    { "author": "alice", "percentage": 62 },
    { "author": "bob", "percentage": 25 }
  ],
  "stale_branches": [
    { "name": "feature/old-experiment", "last_commit": "2025-08-12", "days_stale": 120 }
  ],
  "largest_single_author_files": [
    { "file": "src/core/engine.ts", "author": "alice", "ownership_percentage": 95 }
  ]
}
```

### `find_large_files`
Walks the repository and reports files exceeding a configurable line count threshold.

**Input Schema:**
```json
{
  "repo_path": "string (required) — absolute path to the repository root",
  "threshold": "number (optional, default: 300) — minimum line count to flag",
  "limit": "number (optional, default: 20) — max number of results to return"
}
```

**Output:**
```json
{
  "large_files": [
    { "file": "src/legacy/monolith.ts", "lines": 1842, "size_bytes": 62400 },
    { "file": "src/utils/helpers.ts", "lines": 567, "size_bytes": 18200 }
  ],
  "total_files_scanned": 156,
  "files_over_threshold": 8
}
```

### `get_health_report`
Runs all analyzers and produces a single aggregate health score (0-100) with a letter grade and prioritized recommendations.

**Input Schema:**
```json
{
  "repo_path": "string (required) — absolute path to the repository root"
}
```

**Output:**
```json
{
  "score": 72,
  "grade": "C+",
  "breakdown": {
    "complexity": { "score": 65, "weight": 0.30, "summary": "6 high-complexity functions" },
    "dependencies": { "score": 80, "weight": 0.25, "summary": "1 high vulnerability" },
    "git_health": { "score": 70, "weight": 0.20, "summary": "Bus factor of 2" },
    "dead_code": { "score": 85, "weight": 0.15, "summary": "7 unused exports" },
    "file_size": { "score": 60, "weight": 0.10, "summary": "8 files over 300 lines" }
  },
  "top_recommendations": [
    "Refactor parseExpression (complexity: 18) in src/utils/parser.ts",
    "Update lodash to fix high-severity prototype pollution vulnerability",
    "Split src/legacy/monolith.ts (1842 lines) into smaller modules",
    "Increase contributor diversity — 62% of commits from single author",
    "Remove 7 unused exports to reduce dead code surface"
  ]
}
```

## Architecture

```
sentinel-mcp/
├── src/
│   ├── index.ts                    # MCP server entry, tool registration
│   ├── tools/                      # Tool handlers (one per MCP tool)
│   │   ├── analyze-complexity.ts
│   │   ├── check-dependencies.ts
│   │   ├── detect-dead-code.ts
│   │   ├── git-health.ts
│   │   ├── find-large-files.ts
│   │   └── get-health-report.ts
│   ├── analyzers/                  # Core analysis engines
│   │   ├── ast-analyzer.ts         # Tree-sitter parsing + complexity calc
│   │   ├── dependency-analyzer.ts  # npm/pip audit wrappers
│   │   ├── dead-code-analyzer.ts   # Export/import graph analysis
│   │   ├── git-analyzer.ts         # Git history mining via simple-git
│   │   └── file-analyzer.ts        # File size + line count analysis
│   ├── scoring/
│   │   └── health-scorer.ts        # Weighted 0-100 scoring algorithm
│   └── utils/
│       ├── file-walker.ts          # Recursive traversal, .gitignore aware
│       └── language-detect.ts      # Extension → Tree-sitter grammar map
├── package.json
├── tsconfig.json
└── README.md
```

## Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| MCP SDK | `@modelcontextprotocol/sdk` | Server framework, tool registration, stdio transport |
| AST Parsing | `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python` | Multi-language AST generation for complexity + dead code |
| Git Analysis | `simple-git` | Programmatic git log, shortlog, branch inspection |
| Dep Auditing | `npm audit`, `pip audit` (child_process) | Vulnerability + outdated package detection |
| File Ignore | `ignore` | .gitignore pattern matching for file walker |
| Runtime | Node.js + TypeScript | Type-safe, npm-publishable |

## Build Phases

### Phase 1 — Skeleton + File Walker
- Project scaffold (package.json, tsconfig, directory structure)
- MCP server entry point with stdio transport
- `file-walker.ts` and `language-detect.ts` utilities
- `find_large_files` tool (simplest tool, proves the MCP pipeline works end-to-end)
- Test with Claude Desktop or MCP Inspector

### Phase 2 — AST Pipeline + Complexity
- Tree-sitter integration in `ast-analyzer.ts`
- Cyclomatic complexity calculation per function
- `analyze_complexity` tool handler
- Support for .ts, .tsx, .js, .jsx, .py files

### Phase 3 — Git + Dependencies
- `git-analyzer.ts` with simple-git
- `dependency-analyzer.ts` with npm/pip audit wrappers
- `git_health` and `check_dependencies` tool handlers

### Phase 4 — Dead Code Detection
- Extend AST analyzer to extract export/import declarations
- Build cross-file export/import graph
- `detect_dead_code` tool handler

### Phase 5 — Health Report + Scoring
- `health-scorer.ts` weighted scoring algorithm
- `get_health_report` aggregator tool
- Letter grade system (A+ through F)

### Phase 6 — Polish + Publish
- Robust error handling (non-git repos, empty dirs, permission errors)
- Edge cases (monorepos, symlinks, binary files)
- npm publish config for `npx sentinel-mcp`
- Demo GIFs and usage examples in README

## Configuration

Sentinel requires zero configuration. It accepts a single argument:

```bash
# Via npx (after publishing)
npx sentinel-mcp --repo /path/to/repo

# During development
npx tsx src/index.ts --repo /path/to/repo
```

### Claude Desktop Integration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "npx",
      "args": ["tsx", "/path/to/sentinel-mcp/src/index.ts", "--repo", "/path/to/your/project"]
    }
  }
}
```

## Scoring Algorithm

The health score is a weighted average of five category scores, each normalized to 0-100:

| Category | Weight | Scoring Logic |
|----------|--------|---------------|
| Complexity | 30% | Penalize functions > 10 complexity. Score drops as count and severity increase |
| Dependencies | 25% | Penalize by vulnerability count × severity multiplier (critical=4, high=3, moderate=2, low=1) |
| Git Health | 20% | Reward higher bus factor, recent commit activity, fewer stale branches |
| Dead Code | 15% | Penalize based on percentage of unused exports |
| File Size | 10% | Penalize files over threshold, weighted by how far over |

**Grade Scale:** A+ (97-100), A (93-96), A- (90-92), B+ (87-89), B (83-86), B- (80-82), C+ (77-79), C (73-76), C- (70-72), D+ (67-69), D (63-66), D- (60-62), F (0-59)

## License

MIT
