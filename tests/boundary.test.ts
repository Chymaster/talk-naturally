/**
 * The boundary check is part of the suite, and a failure is a real failure
 * (design/20-architecture.md §3, design/70-stack.md §5, AGENT.md design/20-architecture.md §5).
 *
 * It shares its implementation with `pnpm boundary`, so the two can never drift
 * apart. It must never pass vacuously, which is why the scan asserts a
 * plausible file count before asserting that there are no violations.
 */
import { describe, expect, it } from "vitest";
import { ALLOWED_BARE_IMPORTS, scanCoreBoundary } from "../tools/boundary-scan.js";

const report = scanCoreBoundary();

describe("core boundary", () => {
 it("actually scans the core", () => {
 expect(report.scanned).toBeGreaterThanOrEqual(10);
 });

 it("is intact: no outer-layer import, platform module, or provider name", () => {
 expect(report.violations).toEqual([]);
 });

 it("allows only pure libraries as bare imports", () => {
 expect([...ALLOWED_BARE_IMPORTS]).toEqual(["zod"]);
 });
});
