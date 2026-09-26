import { beforeEach, describe, expect, it } from "vitest";
import { PlatformAssetsBucket } from "../../components/data/platform-assets";
import { installMocks, resourcesOfType, settle } from "../alerting/mock-harness";

beforeEach(() => {
  installMocks();
});

async function build(webOrigin = "https://app.example.test") {
  new PlatformAssetsBucket("platform-assets", { env: "dev", webOrigin });
  await settle();
}

function only(type: string) {
  const found = resourcesOfType(type);
  expect(found, type).toHaveLength(1);
  return found[0]!.inputs;
}

describe("PlatformAssetsBucket (architecture.md §8)", () => {
  it("names the bucket per env so stacks never share one", async () => {
    await build();
    expect(only("aws:s3/bucket:Bucket").bucket).toBe("boxalarm-dev-platform-assets");
  });

  it("blocks every form of public access and enforces bucket-owner object ownership", async () => {
    await build();
    expect(only("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock")).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    expect(only("aws:s3/bucketOwnershipControls:BucketOwnershipControls").rule).toEqual({
      objectOwnership: "BucketOwnerEnforced",
    });
  });

  it("encrypts with SSE-S3 and leaves versioning off", async () => {
    await build();
    const sse = only(
      "aws:s3/bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2",
    );
    expect(sse.rules).toEqual([{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }]);
    expect(
      only("aws:s3/bucketVersioningV2:BucketVersioningV2").versioningConfiguration,
    ).toMatchObject({ status: "Disabled" });
  });

  it("aborts incomplete multipart uploads at 7 days and tiers objects from day 0", async () => {
    await build();
    const [rule] = only("aws:s3/bucketLifecycleConfigurationV2:BucketLifecycleConfigurationV2")
      .rules as Record<string, unknown>[];
    expect(rule).toMatchObject({
      status: "Enabled",
      abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
      transitions: [{ days: 0, storageClass: "INTELLIGENT_TIERING" }],
    });
  });

  it("allows presigned GET/PUT only from the web origin, with the Content-Type preflight header", async () => {
    await build("https://boxalarm.example.test");
    const [rule] = only("aws:s3/bucketCorsConfigurationV2:BucketCorsConfigurationV2")
      .corsRules as Record<string, unknown>[];
    expect(rule).toMatchObject({
      allowedOrigins: ["https://boxalarm.example.test"],
      allowedMethods: ["GET", "PUT"],
      allowedHeaders: ["content-type"],
    });
    expect(rule?.allowedOrigins).not.toContain("*");
  });

  it("denies any non-TLS request to the bucket or its objects", async () => {
    await build();
    const policy = JSON.parse(only("aws:s3/bucketPolicy:BucketPolicy").policy as string) as {
      Statement: Record<string, unknown>[];
    };
    expect(policy.Statement).toEqual([
      expect.objectContaining({
        Effect: "Deny",
        Action: "s3:*",
        Resource: [
          "arn:aws:s3:::boxalarm-dev-platform-assets",
          "arn:aws:s3:::boxalarm-dev-platform-assets/*",
        ],
        Condition: { Bool: { "aws:SecureTransport": "false" } },
      }),
    ]);
  });

  it("throws on an absent env", () => {
    expect(() => new PlatformAssetsBucket("bad", { env: "", webOrigin: "https://x" })).toThrow(
      /env is required/,
    );
  });
});
