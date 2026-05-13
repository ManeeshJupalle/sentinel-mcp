/**
 * Pretty-print the full Sentinel health report for a repository.
 *
 * Usage (from this repo):
 *   npx tsx examples/report.ts [repo_path]
 *
 * Usage (after `npm install sentinel-mcp` in your project): replace the import
 * below with:
 *   import { handleGetHealthReport } from "sentinel-mcp/dist/tools/get-health-report.js";
 */

import { handleGetHealthReport } from "../src/tools/get-health-report.js";

const repoPath = process.argv[2] ?? process.cwd();
const report = await handleGetHealthReport({ repo_path: repoPath });

console.log(`\nSentinel Health Report — ${repoPath}`);
console.log("─".repeat(72));
console.log(`Score:  ${report.score}/100  (${report.grade})\n`);

console.log("Breakdown:");
for (const [category, info] of Object.entries(report.breakdown)) {
  const score =
    info.score === null ? " n/a" : String(info.score).padStart(4);
  const weight = `${Math.round(info.weight * 100)}%`.padStart(4);
  const label = category.padEnd(13);
  console.log(`  ${label}  ${score}  ${weight}   ${info.summary}`);
  if (info.error) {
    console.log(`                              (${info.error})`);
  }
}

if (report.top_recommendations.length > 0) {
  console.log("\nTop recommendations:");
  for (const rec of report.top_recommendations) {
    console.log(`  • ${rec}`);
  }
}
console.log();
