import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";

export interface PlatformAssetsBucketArgs {
  env: string;
  /** The web SPA origin — the only origin allowed to PUT/GET objects via presigned URLs. */
  webOrigin: pulumi.Input<string>;
}

/**
 * The platform-assets bucket (architecture.md §8): cert/PPE attachments, defect and
 * checklist photos, pre-plan diagrams/attachments and inspection photos, all under
 * {deptId}/{entityType}/{entityId}/{filename}. First consumer: inspections-service
 * (pre-plan files, field-capture photos).
 *
 * §8's conventions, applied as the incident-assets bucket (incident/schema-refresh.ts)
 * already applies them: Block Public Access, SSE-S3, versioning off, abort incomplete
 * multipart uploads at 7 days, Intelligent-Tiering from day 0.
 *
 * Deviation from §8, recorded: clients upload/download through regional S3 presigned URLs,
 * not CloudFront signed URLs — N6.1 (U.S. residency, no global edge) forbids CloudFront and
 * residency-encryption.test.ts fails the build on any aws.cloudfront resource. The browser
 * talks to this bucket directly, so it carries a CORS rule scoped to the web origin.
 *
 * Name is env-scoped (boxalarm-{env}-platform-assets, not §8's single
 * nichols-boxalarm-platform-assets) for the reason platform/export.ts documents: S3 names
 * are global, so an unscoped name would let every stack adopt the same bucket.
 */
export class PlatformAssetsBucket extends pulumi.ComponentResource {
  public readonly bucket: aws.s3.Bucket;
  public readonly bucketName: pulumi.Output<string>;
  public readonly bucketArn: pulumi.Output<string>;
  public readonly publicAccessBlock: aws.s3.BucketPublicAccessBlock;
  public readonly cors: aws.s3.BucketCorsConfigurationV2;
  public readonly lifecycle: aws.s3.BucketLifecycleConfigurationV2;
  public readonly bucketPolicy: aws.s3.BucketPolicy;

  constructor(
    name: string,
    args: PlatformAssetsBucketArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    requireEnv("PlatformAssetsBucket", args.env);
    super("boxalarm:data:PlatformAssetsBucket", name, {}, opts);
    const { env } = args;

    this.bucket = new aws.s3.Bucket(
      `${name}-bucket`,
      { bucket: `boxalarm-${env}-platform-assets`, forceDestroy: false },
      { parent: this },
    );
    this.bucketName = this.bucket.bucket;
    this.bucketArn = this.bucket.arn;

    this.publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
      `${name}-bucket-block`,
      {
        bucket: this.bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { parent: this },
    );

    new aws.s3.BucketOwnershipControls(
      `${name}-bucket-ownership`,
      { bucket: this.bucket.id, rule: { objectOwnership: "BucketOwnerEnforced" } },
      { parent: this },
    );

    new aws.s3.BucketServerSideEncryptionConfigurationV2(
      `${name}-bucket-sse`,
      {
        bucket: this.bucket.id,
        rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
      },
      { parent: this },
    );

    new aws.s3.BucketVersioningV2(
      `${name}-bucket-versioning`,
      { bucket: this.bucket.id, versioningConfiguration: { status: "Disabled" } },
      { parent: this },
    );

    this.lifecycle = new aws.s3.BucketLifecycleConfigurationV2(
      `${name}-bucket-lifecycle`,
      {
        bucket: this.bucket.id,
        rules: [
          {
            id: "abort-incomplete-multipart-and-intelligent-tiering",
            status: "Enabled",
            abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
            transitions: [{ days: 0, storageClass: "INTELLIGENT_TIERING" }],
          },
        ],
      },
      { parent: this },
    );

    // The web SPA PUTs files to presigned URLs (features/inspections/api.ts
    // uploadPrePlanFile) and opens presigned GET links; a browser PUT with a File body
    // carries Content-Type, so it is preflighted. Only the configured web origin is allowed.
    this.cors = new aws.s3.BucketCorsConfigurationV2(
      `${name}-bucket-cors`,
      {
        bucket: this.bucket.id,
        corsRules: [
          {
            allowedOrigins: [args.webOrigin],
            allowedMethods: ["GET", "PUT"],
            allowedHeaders: ["content-type"],
            exposeHeaders: ["ETag"],
            maxAgeSeconds: 3000,
          },
        ],
      },
      { parent: this },
    );

    // Presigned URLs are https, but nothing else stops a plain-http request carrying one.
    this.bucketPolicy = new aws.s3.BucketPolicy(
      `${name}-bucket-policy`,
      {
        bucket: this.bucket.id,
        policy: this.bucket.arn.apply((bucketArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "DenyInsecureTransport",
                Effect: "Deny",
                Principal: "*",
                Action: "s3:*",
                Resource: [bucketArn, `${bucketArn}/*`],
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
            ],
          }),
        ),
      },
      { parent: this, dependsOn: [this.publicAccessBlock] },
    );

    this.registerOutputs({ bucketName: this.bucketName, bucketArn: this.bucketArn });
  }
}
