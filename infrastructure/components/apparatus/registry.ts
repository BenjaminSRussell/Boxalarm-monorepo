import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { requireEnv } from "../shared/env";
import { ApparatusArgs, apparatusRoute } from "./apparatus-lambda";

/**
 * Apparatus registry (F4.1) and out-of-service tracking (F4.4).
 *
 * Authorization per route:
 *  - list/get read with the shared authorizer's verified deptId alone (authContext.ts's
 *    readAuthorizerContext, no Cedar) — architecture marks both "Cognito", and the mobile
 *    truck-check picker needs the list for every member. Department isolation is the
 *    dept-scoped GSI3 key.
 *  - create gates on a manual CHIEF/ADMIN cognito:groups check (authContext.ts isAdmin,
 *    same group set as the admin-only Cedar tier) — kept as-is, not moved to Cedar here.
 *  - service-status is Cedar UpdateServiceStatus (apparatus-officer tier).
 */
export class Registry extends pulumi.ComponentResource {
  public readonly listLambda: ServiceLambda;
  public readonly createLambda: ServiceLambda;
  public readonly getLambda: ServiceLambda;
  public readonly serviceStatusLambda: ServiceLambda;

  constructor(name: string, args: ApparatusArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ApparatusRegistry", args.env);
    super("boxalarm:apparatus:Registry", name, {}, opts);

    // listApparatus.ts -> apparatusRepository.listApparatus: GSI3 registry query.
    this.listLambda = apparatusRoute(this, name, args, {
      functionKey: "list",
      routeKey: "GET /api/v1/apparatus",
      cedar: false,
      grants: [{ sid: "ApparatusListQuery", actions: ["dynamodb:Query"], on: ["GSI3"] }],
    });

    // createApparatus.ts -> apparatusRepository.createApparatus: one conditional Put.
    this.createLambda = apparatusRoute(this, name, args, {
      functionKey: "create",
      routeKey: "POST /api/v1/apparatus",
      cedar: false,
      grants: [{ sid: "ApparatusCreatePut", actions: ["dynamodb:PutItem"], on: ["table"] }],
    });

    // getApparatus.ts -> getApparatusDetail: GSI3 lookup by unitId, then base-table
    // queries for open DEFECT# and latest TEST# rows.
    this.getLambda = apparatusRoute(this, name, args, {
      functionKey: "get",
      routeKey: "GET /api/v1/apparatus/{unitId}",
      cedar: false,
      grants: [{ sid: "ApparatusGetQuery", actions: ["dynamodb:Query"], on: ["table", "GSI3"] }],
    });

    // serviceStatusHandler.ts -> repository.setServiceStatus: GSI3 lookup, base-table query
    // for the open OOS# record, then a transaction of Update (METADATA) + Put or Update
    // (OOS# record).
    this.serviceStatusLambda = apparatusRoute(this, name, args, {
      functionKey: "service-status-update",
      routeKey: "PUT /api/v1/apparatus/{unitId}/service-status",
      cedar: true,
      grants: [
        { sid: "ServiceStatusQuery", actions: ["dynamodb:Query"], on: ["table", "GSI3"] },
        {
          sid: "ServiceStatusWrite",
          actions: ["dynamodb:UpdateItem", "dynamodb:PutItem"],
          on: ["table"],
        },
      ],
    });

    this.registerOutputs({
      listLambda: this.listLambda,
      createLambda: this.createLambda,
      getLambda: this.getLambda,
      serviceStatusLambda: this.serviceStatusLambda,
    });
  }
}
