#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import {
  LOAD_ANIM_IDS,
  makeLoadAnim,
} from "../src/lib/anims/index.ts";

const WIDTHS = [40, 80, 120];
const WARMUP_FRAMES = 50;
const SAMPLE_FRAMES = 500;
const BUDGET_MS = 8;

function percentile(sorted, fraction) {
  const index = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * fraction),
  );
  return sorted[index];
}

function format(value) {
  return value.toFixed(4);
}

const results = [];

for (const id of LOAD_ANIM_IDS) {
  const anim = makeLoadAnim(id);
  if (!anim) throw new Error(`registered animation ${id} could not be created`);

  for (const width of WIDTHS) {
    for (let frame = 0; frame < WARMUP_FRAMES; frame++) {
      anim.render(frame, width, "tool");
    }

    const samples = [];
    for (let frame = 0; frame < SAMPLE_FRAMES; frame++) {
      const startedAt = performance.now();
      anim.render(frame, width, "tool");
      samples.push(performance.now() - startedAt);
    }
    samples.sort((a, b) => a - b);

    results.push({
      id,
      width,
      medianMs: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      maxMs: samples.at(-1),
    });
  }
}

console.log("| Pattern | Width | Median ms | p95 ms | Max ms |");
console.log("|---|---:|---:|---:|---:|");
for (const result of results) {
  console.log(
    `| ${result.id} | ${result.width} | ${format(result.medianMs)} | `
    + `${format(result.p95Ms)} | ${format(result.maxMs)} |`,
  );
}

const overBudget = results.filter((result) => result.p95Ms > BUDGET_MS);
if (overBudget.length) {
  console.error(
    `Animation benchmark failed: ${overBudget.length} pattern/width p95 result(s) `
    + `exceeded ${BUDGET_MS} ms.`,
  );
  process.exit(1);
}

console.log(
  `PASS: all ${results.length} pattern/width p95 results stayed within `
  + `${BUDGET_MS} ms (${WARMUP_FRAMES} warm-up, ${SAMPLE_FRAMES} measured frames).`,
);
