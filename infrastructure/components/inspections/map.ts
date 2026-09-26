import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { requireEnv } from "../shared/env";
import { InspectionsBaseArgs, dynamoGrant, inspectionsRoute } from "./shared";

/**
 * F6.6: map retrieval — occupancies and hydrants in a bounding box, via GSI3 geohash5
 * buckets (map/queryMapCells.ts). Cedar-gated (ViewInspectionsMap), read-only.
 */
export class InspectionsMap extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;

  constructor(name: string, args: InspectionsBaseArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("InspectionsMap", args.env);
    super("boxalarm:inspections:InspectionsMap", name, {}, opts);

    this.lambda = inspectionsRoute(this, name, args, {
      fn: "map",
      routeKey: "GET /api/v1/inspections/map",
      environment: { PLATFORM_TABLE_NAME: args.platformTableName },
      cedar: true,
      statements: ({ tableArn }) => [
        dynamoGrant("InspectionsMapQuery", ["dynamodb:Query"], [`${tableArn}/index/GSI3`]),
      ],
    });

    this.registerOutputs({ lambda: this.lambda });
  }
}
