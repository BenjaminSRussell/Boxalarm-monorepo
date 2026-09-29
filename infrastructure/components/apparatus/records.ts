import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { requireEnv } from "../shared/env";
import { ApparatusArgs, apparatusRoute } from "./apparatus-lambda";

/**
 * Maintenance (F4.5), SCBA records (F4.6) and hose/ladder/pump/aerial testing (F4.7).
 * Every route is Cedar-gated. The maintenance routes' {unitId} path segment carries the
 * apparatusId (the web MaintenanceTab passes unit.apparatusId, and getMaintenance.ts /
 * postMaintenance.ts key on it directly), so neither needs the GSI3 unitId lookup.
 *
 * The daily apparatusTestingScanner/testDueScanner Lambdas have no HTTP route; they are
 * scheduled in test-due-scanners.ts.
 */
export class Records extends pulumi.ComponentResource {
  public readonly maintenanceGetLambda: ServiceLambda;
  public readonly maintenanceLogLambda: ServiceLambda;
  public readonly scbaLogLambda: ServiceLambda;
  public readonly scbaTestingSchedulesLambda: ServiceLambda;
  public readonly testsLogLambda: ServiceLambda;
  public readonly testingSchedulesLambda: ServiceLambda;

  constructor(name: string, args: ApparatusArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ApparatusRecords", args.env);
    super("boxalarm:apparatus:Records", name, {}, opts);

    // getMaintenance.ts: one base-table Query on MAINT#.
    this.maintenanceGetLambda = apparatusRoute(this, name, args, {
      functionKey: "maintenance-get",
      routeKey: "GET /api/v1/apparatus/{unitId}/maintenance",
      cedar: true,
      grants: [{ sid: "MaintenanceHistoryQuery", actions: ["dynamodb:Query"], on: ["table"] }],
    });

    // postMaintenance.ts: GetItem (apparatus METADATA exists), then one Put.
    this.maintenanceLogLambda = apparatusRoute(this, name, args, {
      functionKey: "maintenance-log",
      routeKey: "POST /api/v1/apparatus/{unitId}/maintenance",
      cedar: true,
      grants: [
        {
          sid: "MaintenanceLogWrite",
          actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
          on: ["table"],
        },
      ],
    });

    // postScba.ts: GSI3 lookup by unitId, then a transaction of four Puts.
    this.scbaLogLambda = apparatusRoute(this, name, args, {
      functionKey: "scba-log",
      routeKey: "POST /api/v1/apparatus/{unitId}/scba",
      cedar: true,
      grants: [
        { sid: "ScbaApparatusLookup", actions: ["dynamodb:Query"], on: ["GSI3"] },
        { sid: "ScbaLogWrite", actions: ["dynamodb:PutItem"], on: ["table"] },
      ],
    });

    // getScbaTestingSchedules.ts: per-month GSI2 due-date queries. Not in the architecture
    // route table; the path is the one the web client calls (features/apparatus/api.ts
    // getScbaDueSoon). A literal segment, so it never collides with /{unitId}/scba.
    this.scbaTestingSchedulesLambda = apparatusRoute(this, name, args, {
      functionKey: "scba-testing-schedules",
      routeKey: "GET /api/v1/apparatus/scba/testing-schedules",
      cedar: true,
      grants: [{ sid: "ScbaDueQuery", actions: ["dynamodb:Query"], on: ["GSI2"] }],
    });

    // postTestRecord.ts: GSI3 lookup by unitId, then a transaction of two Puts.
    this.testsLogLambda = apparatusRoute(this, name, args, {
      functionKey: "tests-log",
      routeKey: "POST /api/v1/apparatus/{unitId}/tests",
      cedar: true,
      grants: [
        { sid: "TestLogApparatusLookup", actions: ["dynamodb:Query"], on: ["GSI3"] },
        { sid: "TestLogWrite", actions: ["dynamodb:PutItem"], on: ["table"] },
      ],
    });

    // getTestingSchedules.ts: GSI2 due window, then the GSI3 registry for unitId labels.
    this.testingSchedulesLambda = apparatusRoute(this, name, args, {
      functionKey: "testing-schedules",
      routeKey: "GET /api/v1/apparatus/testing-schedules",
      cedar: true,
      grants: [{ sid: "TestingSchedulesQuery", actions: ["dynamodb:Query"], on: ["GSI2", "GSI3"] }],
    });

    this.registerOutputs({
      maintenanceGetLambda: this.maintenanceGetLambda,
      maintenanceLogLambda: this.maintenanceLogLambda,
      scbaLogLambda: this.scbaLogLambda,
      scbaTestingSchedulesLambda: this.scbaTestingSchedulesLambda,
      testsLogLambda: this.testsLogLambda,
      testingSchedulesLambda: this.testingSchedulesLambda,
    });
  }
}
