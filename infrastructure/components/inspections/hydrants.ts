import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { requireEnv } from "../shared/env";
import { InspectionsBaseArgs, dynamoGrant, inspectionsRoute } from "./shared";

/**
 * F6.4: hydrant records. The list is a dept-scoped read with no Cedar call (architecture:
 * `Cognito`); create/update are Cedar-gated (CreateHydrant/UpdateHydrant).
 */
export class Hydrants extends pulumi.ComponentResource {
  public readonly listLambda: ServiceLambda;
  public readonly createLambda: ServiceLambda;
  public readonly updateLambda: ServiceLambda;

  constructor(name: string, args: InspectionsBaseArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Hydrants", args.env);
    super("boxalarm:inspections:Hydrants", name, {}, opts);
    const environment = { PLATFORM_TABLE_NAME: args.platformTableName };

    // listHydrants: GSI3 list-partition Query + BatchGetItem (no dueBefore); with dueBefore,
    // queryHydrantsDueWithin's GSI2 month-bucket Query.
    this.listLambda = inspectionsRoute(this, name, args, {
      fn: "hydrants-list",
      routeKey: "GET /api/v1/inspections/hydrants",
      environment,
      cedar: false,
      statements: ({ tableArn }) => [
        dynamoGrant(
          "HydrantsListQuery",
          ["dynamodb:Query"],
          [`${tableArn}/index/GSI2`, `${tableArn}/index/GSI3`],
        ),
        dynamoGrant("HydrantsListBatchGet", ["dynamodb:BatchGetItem"], [tableArn]),
      ],
    });

    // createHydrant: one transaction of two Puts (METADATA + LIST index item).
    this.createLambda = inspectionsRoute(this, name, args, {
      fn: "hydrants-create",
      routeKey: "POST /api/v1/inspections/hydrants",
      environment,
      cedar: true,
      statements: ({ tableArn }) => [
        dynamoGrant("HydrantsCreate", ["dynamodb:PutItem"], [tableArn]),
      ],
    });

    // updateHydrant: GetItem (pre-image for the outbox payload), a transaction of Update
    // (hydrant) + Put (inspections.hydrant.updated outbox row), then a GetItem read-back.
    this.updateLambda = inspectionsRoute(this, name, args, {
      fn: "hydrants-update",
      routeKey: "PUT /api/v1/inspections/hydrants/{hydrantId}",
      environment,
      cedar: true,
      mutatesTable: true,
      statements: ({ tableArn }) => [
        dynamoGrant(
          "HydrantsUpdate",
          ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
          [tableArn],
        ),
      ],
    });

    this.registerOutputs({
      listLambda: this.listLambda,
      createLambda: this.createLambda,
      updateLambda: this.updateLambda,
    });
  }
}
