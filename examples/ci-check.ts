/**
 * CI quality gate — exits non-zero when the repo's health score is below a
 * threshold. Drop this into a GitHub Actions step, a pre-commit hook, or any
 * pipeline that should block on quality regressions.
 *
 * Usage (from this repo):
 *   npx tsx examples/ci-check.ts [repo_path] [min_score]
 *
 * Usage (after `npm install sentinel-mcp` in your project): replace the import
 * below with:
 *   import { handleGetHealthReport } from "sentinel-mcp/dist/tools/get-health-report.js";
 */

import { handleGetHealthReport } from "../src/tools/get-health-report.js";

const repoPath = process.argv[2] ?? process.cwd();
const minScore = Number(process.argv[3] ?? 70);

const report = await handleGetHealthReport({ repo_path: repoPath });

console.log(`Sentinel score: ${report.score} (${report.grade})`);

if (report.score < minScore) {
  console.error(`\nScore ${report.score} is below threshold ${minScore}.`);
  console.error("Top issues:");
  for (const rec of report.top_recommendations.slice(0, 3)) {
    console.error(`  - ${rec}`);
  }
  process.exit(1);
}
