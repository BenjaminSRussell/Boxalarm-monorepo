import * as path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

/**
 * The HTTP API authorizer used to be wired to a deny-all stub, and the real backend
 * authorizer was in no bundle - so every authenticated route in the stack answered 403.
 * These guard both halves of that seam.
 */
describe("API authorizer wiring", () => {
  it("the backend manifest bundles platform-service/authorizer from the real handler", async () => {
    const manifestPath = path.resolve(__dirname, "../../../backend/scripts/lambda-manifest.mjs");
    const { LAMBDA_ENTRIES } = (await import(pathToFileURL(manifestPath).href)) as {
      LAMBDA_ENTRIES: Array<{ service: string; function: string; entry: string }>;
    };
    expect(LAMBDA_ENTRIES).toContainEqual({
      service: "platform-service",
      function: "authorizer",
      entry: "src/services/platform-service/authorizer/handler.ts",
    });
  });

  it("the bundler keeps class names, which the authorizer's deny-reason metric reports", async () => {
    const fs = await import("fs");
    const bundleScript = fs.readFileSync(
      path.resolve(__dirname, "../../../backend/scripts/bundle.mjs"),
      "utf8",
    );
    expect(bundleScript).toMatch(/keepNames:\s*true/);
  });
});
