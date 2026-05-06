import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeHealthScore,
  letterGrade,
} from "../src/scoring/health-scorer.js";

test("letterGrade: boundary scores map to expected grades", () => {
  assert.equal(letterGrade(100), "A+");
  assert.equal(letterGrade(97), "A+");
  assert.equal(letterGrade(96), "A");
  assert.equal(letterGrade(93), "A");
  assert.equal(letterGrade(92), "A-");
  assert.equal(letterGrade(90), "A-");
  assert.equal(letterGrade(89), "B+");
  assert.equal(letterGrade(80), "B-");
  assert.equal(letterGrade(72), "C-");
  assert.equal(letterGrade(60), "D-");
  assert.equal(letterGrade(59), "F");
  assert.equal(letterGrade(0), "F");
});

test("computeHealthScore: a perfect repo grades A+", () => {
  const r = computeHealthScore({
    complexity: {
      result: {
        files_analyzed: 5,
        total_functions: 10,
        high_complexity_functions: [],
        average_complexity: 2,
        distribution: { low: 10, moderate: 0, high: 0, critical: 0 },
      },
    },
    dependencies: {
      result: {
        package_manager: "npm",
        total_dependencies: 5,
        vulnerabilities: [],
        outdated_count: 0,
        vulnerability_summary: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    },
    git_health: {
      result: {
        commit_frequency: { last_30_days: 50, last_90_days: 100 },
        bus_factor: 5,
        contributor_concentration: [],
        stale_branches: [],
        largest_single_author_files: [],
      },
    },
    dead_code: {
      result: {
        potentially_dead_exports: [],
        total_exports: 20,
        unused_count: 0,
        unused_percentage: 0,
      },
    },
    file_size: {
      result: {
        large_files: [],
        total_files_scanned: 30,
        files_over_threshold: 0,
      },
    },
  });
  assert.equal(r.score, 100);
  assert.equal(r.grade, "A+");
});

test("computeHealthScore: failed git analyzer renormalizes weights", () => {
  const r = computeHealthScore({
    complexity: {
      result: {
        files_analyzed: 5,
        total_functions: 10,
        high_complexity_functions: [],
        average_complexity: 2,
        distribution: { low: 10, moderate: 0, high: 0, critical: 0 },
      },
    },
    dependencies: {
      result: {
        package_manager: "npm",
        total_dependencies: 5,
        vulnerabilities: [],
        outdated_count: 0,
        vulnerability_summary: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    },
    git_health: { error: "not a git repository" },
    dead_code: {
      result: {
        potentially_dead_exports: [],
        total_exports: 0,
        unused_count: 0,
        unused_percentage: 0,
      },
    },
    file_size: {
      result: {
        large_files: [],
        total_files_scanned: 0,
        files_over_threshold: 0,
      },
    },
  });
  assert.equal(r.breakdown.git_health.score, null);
  assert.equal(r.breakdown.git_health.error, "not a git repository");
  // The remaining four categories all score 100, so the renormalized aggregate
  // must also be 100 (not pulled down toward zero by the missing 0.20 weight).
  assert.equal(r.score, 100);
});

test("computeHealthScore: outdated packages drag the score even with zero vulns", () => {
  const baseInputs = {
    complexity: {
      result: {
        files_analyzed: 0,
        total_functions: 0,
        high_complexity_functions: [],
        average_complexity: 0,
        distribution: { low: 0, moderate: 0, high: 0, critical: 0 },
      },
    },
    git_health: { error: "not a git repository" },
    dead_code: {
      result: {
        potentially_dead_exports: [],
        total_exports: 0,
        unused_count: 0,
        unused_percentage: 0,
      },
    },
    file_size: {
      result: {
        large_files: [],
        total_files_scanned: 0,
        files_over_threshold: 0,
      },
    },
  } as const;

  const clean = computeHealthScore({
    ...baseInputs,
    dependencies: {
      result: {
        package_manager: "npm",
        total_dependencies: 10,
        vulnerabilities: [],
        outdated_count: 0,
        vulnerability_summary: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    },
  });
  const outdated = computeHealthScore({
    ...baseInputs,
    dependencies: {
      result: {
        package_manager: "npm",
        total_dependencies: 10,
        vulnerabilities: [],
        outdated_count: 5,
        vulnerability_summary: { critical: 0, high: 0, moderate: 0, low: 0 },
      },
    },
  });
  assert.equal(clean.breakdown.dependencies.score, 100);
  assert.equal(outdated.breakdown.dependencies.score, 95); // 100 - min(5,10)
  assert.ok(
    outdated.score < clean.score,
    `outdated repo (${outdated.score}) should score lower than clean (${clean.score})`
  );
});
