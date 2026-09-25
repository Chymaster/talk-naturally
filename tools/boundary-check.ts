/**
 * `pnpm boundary` — fails the build when the core boundary is broken
 * (AGENT.md §4: "a failure is a real failure, not a warning").
 */
import { scanCoreBoundary } from "./boundary-scan.js";

const MINIMUM_EXPECTED_FILES = 10;

const report = scanCoreBoundary();

if (report.scanned < MINIMUM_EXPECTED_FILES) {
  console.error(
    `core boundary check scanned only ${report.scanned} files, which is implausibly few. ` +
      "Refusing to report success — the check itself is broken.",
  );
  process.exit(1);
}

if (report.violations.length > 0) {
  console.error(`core boundary violations (${report.violations.length}):`);
  for (const violation of report.violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log(`✔ core boundary intact (${report.scanned} files scanned)`);
