import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { auditMutationDenyStatement } from "../data/platform-table";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface InboxArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
}

/**
 * notification-service in-app inbox and notification preferences (architecture.md
 * §1.1 service 10). Both Lambdas are LOB plane: they read and write only the platform
 * table (NOTIFICATION / NOTIFICATION_PREFERENCE entities under the caller's own
 * DEPT#{deptId}#MEMBER#{sub} partition) and share nothing with the alerting plane.
 *
 * Paths are /api/v1/notifications/... — the architecture route table still lists the
 * bare /notifications form, but the web and mobile clients both prefix /api/v1/ and
 * every other service follows that convention. Each handler file dispatches its two
 * routes on routeKey, so one Lambda per file.
 */
export class Inbox extends pulumi.ComponentResource {
  public readonly inboxLambda: ServiceLambda;
  public readonly preferencesLambda: ServiceLambda;

  constructor(name: string, args: InboxArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("Inbox", args.env);
    super("boxalarm:notification:Inbox", name, {}, opts);
    const { env } = args;

    const environment = {
      PLATFORM_SERVICE_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
    };

    // inbox/handler.ts: list is a base-table Query (begins_with NOTIF#); mark-read Queries
    // GSI1 for the notification's sk, then a conditional UpdateItem sets readAt.
    this.inboxLambda = new ServiceLambda(
      `${name}-inbox`,
      {
        env,
        serviceName: "notification-service",
        functionName: `boxalarm-${env}-notification-inbox`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("notification-service", "inbox"),
        logGroup: args.logGroup,
        environment,
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              Sid: "NotificationInboxRead" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query"],
              Resource: [tableArn, `${tableArn}/index/GSI1`],
            },
            {
              Sid: "NotificationInboxMarkRead" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:UpdateItem"],
              Resource: [tableArn],
            },
            auditMutationDenyStatement(tableArn),
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-inbox-list-route`,
      { routeKey: "GET /api/v1/notifications", lambda: this.inboxLambda },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-inbox-mark-read-route`,
      { routeKey: "POST /api/v1/notifications/{id}/read", lambda: this.inboxLambda },
      { parent: this },
    );

    // preferences/handler.ts: GET is a base-table Query (begins_with NOTIFPREF#), PUT is a
    // single PutItem.
    this.preferencesLambda = new ServiceLambda(
      `${name}-preferences`,
      {
        env,
        serviceName: "notification-service",
        functionName: `boxalarm-${env}-notification-preferences`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("notification-service", "preferences"),
        logGroup: args.logGroup,
        environment,
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn])
          .apply(([tableArn, policyStoreArn]) => [
            {
              Sid: "NotificationPreferencesAccess" as const,
              Effect: "Allow" as const,
              Action: ["dynamodb:Query", "dynamodb:PutItem"],
              Resource: [tableArn],
            },
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-preferences-get-route`,
      { routeKey: "GET /api/v1/notifications/preferences", lambda: this.preferencesLambda },
      { parent: this },
    );
    args.httpApi.route(
      `${name}-preferences-put-route`,
      { routeKey: "PUT /api/v1/notifications/preferences", lambda: this.preferencesLambda },
      { parent: this },
    );

    this.registerOutputs({
      inboxLambda: this.inboxLambda,
      preferencesLambda: this.preferencesLambda,
    });
  }
}
