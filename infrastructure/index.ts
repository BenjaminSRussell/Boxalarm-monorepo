import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Config, getStack } from "@pulumi/pulumi";
import { ServiceLogGroup, serviceLogGroupName } from "./components/observability/service-log-group";
import { ServiceDashboard } from "./components/observability/service-dashboard";
import {
  createDefaultSamplingRule,
  createAlertingSamplingRule,
} from "./components/observability/xray-sampling";
import { SERVICES, ServiceName } from "./components/observability/services";
import { BoxalarmUserPool } from "./components/identity/user-pool";
import { BoxalarmUserPoolClient } from "./components/identity/user-pool-client";
import { HttpApi } from "./components/api/http-api";
import { ServiceHealth } from "./components/api/service-health";
import { PlatformTable } from "./components/data/platform-table";
import { IncidentTable } from "./components/data/incident-table";
import { AlertingTable } from "./components/data/alerting-table";
import { AuditTrail } from "./components/data/audit-trail";
import { PlatformAssetsBucket } from "./components/data/platform-assets";
import { NerisConfig } from "./components/neris/neris-config";
import { PolicyStore } from "./components/authz/policy-store";
import { PlatformBus } from "./components/messaging/platform-bus";
import { OutboxPublisher } from "./components/messaging/outbox-publisher";
import { SessionRevocation } from "./components/identity/session-revocation";
import { RecoveryMonitor } from "./components/identity/recovery-monitor";
import { Members } from "./components/personnel/members";
import { Quals } from "./components/personnel/quals";
import { Attendance } from "./components/personnel/attendance";
import { Availability } from "./components/personnel/availability";
import { Losap } from "./components/personnel/losap";
import { Shifts } from "./components/personnel/shifts";
import { Certifications } from "./components/training/certifications";
import { Events as TrainingEvents } from "./components/training/events";
import { Hours as TrainingHours } from "./components/training/hours";
import { Reports as TrainingReports } from "./components/training/reports";
import { Transcript as TrainingTranscript } from "./components/training/transcript";
import { Registry as ApparatusRegistry } from "./components/apparatus/registry";
import { Checks as ApparatusChecks } from "./components/apparatus/checks";
import { Records as ApparatusRecords } from "./components/apparatus/records";
import { Inventory as ApparatusInventory } from "./components/apparatus/inventory";
import { TestDueScanners as ApparatusTestDueScanners } from "./components/apparatus/test-due-scanners";
import { Equipment as InventoryEquipment } from "./components/inventory/equipment";
import { Consumables as InventoryConsumables } from "./components/inventory/consumables";
import { Ppe as InventoryPpe } from "./components/inventory/ppe";
import { Occupancies } from "./components/inspections/occupancies";
import { Hydrants } from "./components/inspections/hydrants";
import { Records as InspectionRecords } from "./components/inspections/records";
import { InspectionsMap } from "./components/inspections/map";
import { Inbox as NotificationInbox } from "./components/notification/inbox";
import { Digest as NotificationDigest } from "./components/notification/digest";
import { Reminders as NotificationReminders } from "./components/notification/reminders";
import { Config as PlatformConfig } from "./components/platform/config";
import { AuditRoute } from "./components/platform/audit-route";
import { Export } from "./components/platform/export";
import { Retention } from "./components/platform/retention";
import { ChiefNotificationTopic } from "./components/shared/chief-notifications";
import { Reporting } from "./components/reporting/reporting";
import { Incident } from "./components/incident/incident";
import { SchemaRefresh } from "./components/incident/schema-refresh";
import { IncidentOutboxDrain } from "./components/incident/outbox-drain";
import { NerisSubmissionWorker } from "./components/incident/submission-worker";
import { AlertingPlaneBoundary } from "./components/alerting/iam-boundary";
import { MessagingAlerting } from "./components/alerting/messaging-alerting";
import { Escalation } from "./components/alerting/escalation";
import { FanOut } from "./components/alerting/fan-out";
import { ChannelWorkers } from "./components/alerting/channel-workers";
import { RoutesCore } from "./components/alerting/routes-core";
import { RoutesOps } from "./components/alerting/routes-ops";
import { RoutesLadderControls } from "./components/alerting/routes-ladder-controls";
import { PushTokens } from "./components/alerting/push-tokens";
import { RidingBoard } from "./components/alerting/riding-board";
import { AlertingAlarms } from "./components/alerting/alarms";
import { EligibilityStaleness } from "./components/alerting/staleness";
import { AlertingCanary } from "./components/alerting/canary";
import { AlertingOutboxDrain } from "./components/alerting/outbox-drain";

export const stack = getStack();
const config = new Config("boxalarm-infra");
export const env = config.require("env");
export const webOrigin = config.require("webOrigin");
// Single-tenant today (Nichols FD) — {deptId} is in every partition key so a second
// department is additive later, not a rewrite (CLAUDE.md). The cert-expiry scanner
// (E3-S3/S8-INFRA) has no HTTP caller to read deptId from a verified JWT, so it is
// configured per stack instead.
export const deptId = config.require("deptId");
// Not yet published: the offline pipeline that normalizes the upstream
// neris-framework XLSX/YAML feed into the JSON shape schemaVersion/
// refreshScanner/handler.ts fetches doesn't have a URL yet (E6-S11-INFRA
// #246's own scope note). Required config, set out-of-band per env once
// that pipeline exists, rather than a guessed literal.
export const nerisSchemaSourceUrl = config.require("nerisSchemaSourceUrl");
// Verified SES sender for notification-service's email digests (e.g.
// notifications@<dept domain>). Required, not defaulted: without it every digest
// send throws and no reminder ever reaches the inbox. SES identity verification (and
// production access) is out-of-band per env.
export const notificationSesFromAddress = config.require("notificationSesFromAddress");

// #180 / #6: base identity + pre-token-generation trigger that puts
// custom:deptId on the ACCESS token for the shared authorizer.
export const identity = new BoxalarmUserPool("identity", { env });
export const userPoolId = identity.userPool.id;

const SELF_SERVICE_WRITE_ATTRIBUTES = ["email", "name", "phone_number"] as const;

// E8-S8-INFRA #259: identical token policy on both clients — sign in once and
// forget (CLAUDE.md); revocation is the only control that ends a session.
const SESSION_TOKEN_POLICY = {
  enableTokenRevocation: true,
  accessTokenValidityHours: 1,
  idTokenValidityHours: 1,
  refreshTokenValidityDays: 3650,
  refreshTokenRotationGraceSeconds: 60,
} as const;

export const mobileUserPoolClient = new BoxalarmUserPoolClient("identity-client-mobile", {
  userPoolId: identity.userPool.id,
  clientName: `boxalarm-${env}-mobile`,
  standardWriteAttributes: SELF_SERVICE_WRITE_ATTRIBUTES,
  callbackUrls: ["boxalarm://auth"],
  logoutUrls: ["boxalarm://auth"],
  ...SESSION_TOKEN_POLICY,
});

export const webUserPoolClient = new BoxalarmUserPoolClient("identity-client-web", {
  userPoolId: identity.userPool.id,
  clientName: `boxalarm-${env}-web`,
  standardWriteAttributes: SELF_SERVICE_WRITE_ATTRIBUTES,
  // silent-renew.html is required for the iframe fallback path (#6 comment).
  callbackUrls: [`${webOrigin}/auth/callback`, `${webOrigin}/silent-renew.html`],
  logoutUrls: [webOrigin],
  ...SESSION_TOKEN_POLICY,
});

const region = aws.getRegionOutput();
export const cognitoIssuer = pulumi.interpolate`https://cognito-idp.${region.name}.amazonaws.com/${identity.userPool.id}`;

export const defaultSamplingRule = createDefaultSamplingRule(env);
export const alertingSamplingRule = createAlertingSamplingRule(env);

export const serviceLogGroups = SERVICES.map(
  (serviceName) => new ServiceLogGroup(`${serviceName}-log-group`, { env, serviceName }),
);

export const serviceLogGroupNames = Object.fromEntries(
  SERVICES.map((s) => [s, serviceLogGroupName(env, s)]),
);

// Name-keyed, not positional: SERVICES.indexOf("platform-service") returning -1 on a
// rename/reorder would silently yield undefined here with no compile-time signal.
const serviceLogGroupByName = Object.fromEntries(
  SERVICES.map((s, i) => [s, serviceLogGroups[i]]),
) as Record<ServiceName, ServiceLogGroup>;
const platformLogGroup = serviceLogGroupByName["platform-service"];
const alertingLogGroup = serviceLogGroupByName["alerting-service"];
const personnelLogGroup = serviceLogGroupByName["personnel-service"];
const apparatusLogGroup = serviceLogGroupByName["apparatus-service"];

export const serviceDashboards = SERVICES.map(
  (serviceName) => new ServiceDashboard(`${serviceName}-dashboard`, { env, serviceName }),
);

// E8-S1-INFRA #6 residual: shared HTTP API + authorizer (consumes ServiceLambda / #88).
export const httpApi = new HttpApi("http-api", {
  env,
  userPoolId: identity.userPool.id,
  allowedClientIds: [webUserPoolClient.userPoolClient.id, mobileUserPoolClient.userPoolClient.id],
  platformLogGroup,
});

// Shared data plane tables (ownership: #84 platform, #62 incident, #48 alerting).
export const platformTable = new PlatformTable("platform", { env });
export const incidentTable = new IncidentTable("incident", { env });
export const alertingTable = new AlertingTable("alerting", { env });
// architecture.md §8 platform-assets bucket (pre-plan files, inspection photos, and later
// cert/PPE/defect attachments), reached by clients through S3 presigned URLs.
export const platformAssets = new PlatformAssetsBucket("platform-assets", { env, webOrigin });

// E8-S5-INFRA #84: CloudTrail data events on alerting table + Object Lock archive.
export const auditTrail = new AuditTrail("audit-trail", {
  env,
  alertingTableArn: alertingTable.table.arn,
});

// E1-S13-INFRA #38: alerting isolation as an enforced IAM boundary, attached to every
// alerting-service role below. Relocated here (was after incidentSchemaRefresh/incident)
// so alertingBoundaryArn exists before personnelQuals/personnelAvailability/
// trainingCertifications instantiate their own alerting-service Lambdas (ELIG-INFRA).
export const alertingPlaneBoundary = new AlertingPlaneBoundary("alerting-plane-boundary", {
  env,
  platformTableArn: platformTable.tableArn,
  incidentTableArn: incidentTable.tableArn,
});
const alertingBoundaryArn = alertingPlaneBoundary.policy.arn;

// E6-S7-INFRA #68: NERIS per-env secret + SSM (values out-of-band).
export const nerisConfig = new NerisConfig("neris", { env });

// E8-S3-INFRA #255: shared Verified Permissions policy store.
export const policyStore = new PolicyStore("policy-store", {
  env,
  userPoolId: identity.userPool.id,
  userPoolArn: identity.userPool.arn,
  allowedClientIds: [webUserPoolClient.userPoolClient.id, mobileUserPoolClient.userPoolClient.id],
});

// E8-S8-INFRA #259: shared LOB EventBridge bus.
export const platformBus = new PlatformBus("platform-bus", { env });

// E2-S1-INFRA #203: the ONE platform-table outbox → platform-bus publisher.
export const outboxPublisher = new OutboxPublisher("outbox-publisher", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  platformTableStreamArn: platformTable.streamArn,
  busName: platformBus.busName,
  busArn: platformBus.busArn,
  logGroup: platformLogGroup,
});

export const sessionRevocation = new SessionRevocation("session-revocation", {
  env,
  userPoolId: identity.userPool.id,
  userPoolArn: identity.userPool.arn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  platformLogGroup,
  httpApi,
  platformBus,
});

export const recoveryMonitor = new RecoveryMonitor("recovery-monitor", {
  env,
  logGroup: platformLogGroup,
});

export const personnelMembers = new Members("personnel-members", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  userPoolId: identity.userPool.id,
  userPoolArn: identity.userPool.arn,
  logGroup: personnelLogGroup,
  httpApi,
});

// E2-S2 through E2-S11-INFRA (#204-#213): personnel domain routes beyond the roster CRUD
// E2-S1-INFRA already wired above — all share the platform table (no dedicated
// personnel table exists) and the shared policy store.
export const personnelQuals = new Quals("personnel-quals", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: personnelLogGroup,
  httpApi,
  platformBus,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  alertingLogGroup,
  alertingPermissionsBoundaryArn: alertingBoundaryArn,
});

export const personnelAttendance = new Attendance("personnel-attendance", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: personnelLogGroup,
  httpApi,
});

export const personnelAvailability = new Availability("personnel-availability", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: personnelLogGroup,
  httpApi,
  platformBus,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  alertingLogGroup,
  alertingPermissionsBoundaryArn: alertingBoundaryArn,
});

export const personnelLosap = new Losap("personnel-losap", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: personnelLogGroup,
  httpApi,
});

export const personnelShifts = new Shifts("personnel-shifts", {
  env,
  deptId,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: personnelLogGroup,
  httpApi,
});

// E3-S1 through E3-S8-INFRA (#214-#221): training domain — certifications (with
// attachments and the expiry scanner), events, hours, ISO reporting, transcript. All
// share the platform table; the training-service log group already exists (services.ts).
const trainingLogGroup = serviceLogGroupByName["training-service"];

export const trainingCertifications = new Certifications("training-certifications", {
  env,
  deptId,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  platformBusName: platformBus.busName,
  platformBusArn: platformBus.busArn,
  platformTableStreamArn: platformTable.streamArn,
  assetsBucketName: platformAssets.bucketName,
  assetsBucketArn: platformAssets.bucketArn,
  logGroup: trainingLogGroup,
  httpApi,
});

export const trainingEvents = new TrainingEvents("training-events", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: trainingLogGroup,
  httpApi,
});

export const trainingHours = new TrainingHours("training-hours", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: trainingLogGroup,
  httpApi,
});

export const trainingReports = new TrainingReports("training-reports", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: trainingLogGroup,
  httpApi,
});

export const trainingTranscript = new TrainingTranscript("training-transcript", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: trainingLogGroup,
  httpApi,
});

// api-gap P0 #5: apparatus-service registry, checks/defects/compliance, maintenance/SCBA/
// testing records, and compartment inventory. All on the platform table and the shared
// policy store; the riding board stays in components/alerting/riding-board.ts.
const apparatusArgs = {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  assetsBucketName: platformAssets.bucketName,
  assetsBucketArn: platformAssets.bucketArn,
  logGroup: apparatusLogGroup,
  httpApi,
};
export const apparatusRegistry = new ApparatusRegistry("apparatus-registry", apparatusArgs);
export const apparatusChecks = new ApparatusChecks("apparatus-checks", apparatusArgs);
export const apparatusRecords = new ApparatusRecords("apparatus-records", apparatusArgs);
export const apparatusInventory = new ApparatusInventory("apparatus-inventory", apparatusArgs);
// Daily apparatus/SCBA test-due scanners -> apparatus.test.due on the platform bus.
export const apparatusTestDueScanners = new ApparatusTestDueScanners(
  "apparatus-test-due-scanners",
  {
    env,
    deptId,
    platformTableName: platformTable.tableName,
    platformTableArn: platformTable.tableArn,
    platformBusName: platformBus.busName,
    platformBusArn: platformBus.busArn,
    logGroup: apparatusLogGroup,
  },
);

// api-gap P0-6: inventory-service — equipment registry, consumables and PPE, plus the
// daily consumable-reorder and PPE-expiry scanners. All share the platform table.
// Compartment inventory (/apparatus/{unitId}/inventory) belongs to apparatus-service.
const inventoryLogGroup = serviceLogGroupByName["inventory-service"];
const inventoryCommon = {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: inventoryLogGroup,
  httpApi,
};

export const inventoryEquipment = new InventoryEquipment("inventory-equipment", inventoryCommon);

export const inventoryConsumables = new InventoryConsumables("inventory-consumables", {
  ...inventoryCommon,
  deptId,
  platformBusName: platformBus.busName,
  platformBusArn: platformBus.busArn,
});

export const inventoryPpe = new InventoryPpe("inventory-ppe", {
  ...inventoryCommon,
  deptId,
  platformBusName: platformBus.busName,
  platformBusArn: platformBus.busArn,
});

// F6 inspections-service: occupancies + pre-plans, hydrants, inspection records + field
// capture, and the map. All state is in the platform table; pre-plan files and field-capture
// photos go to the platform-assets bucket through S3 presigned URLs.
const inspectionsLogGroup = serviceLogGroupByName["inspections-service"];
const inspectionsBase = {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: inspectionsLogGroup,
  httpApi,
};

export const inspectionsOccupancies = new Occupancies("inspections-occupancies", {
  ...inspectionsBase,
  assetsBucketName: platformAssets.bucketName,
  assetsBucketArn: platformAssets.bucketArn,
});

export const inspectionsHydrants = new Hydrants("inspections-hydrants", inspectionsBase);

export const inspectionsRecords = new InspectionRecords("inspections-records", {
  ...inspectionsBase,
  assetsBucketName: platformAssets.bucketName,
  assetsBucketArn: platformAssets.bucketArn,
});

export const inspectionsMap = new InspectionsMap("inspections-map", inspectionsBase);

// notification-service (architecture.md §1.1 service 10): LOB-plane in-app inbox,
// preferences, and the cert-expiry -> daily digest chain that fills the inbox. Entities
// live on the platform table; shares no queue, concurrency reservation, topic or
// provider with the alerting plane.
const notificationLogGroup = serviceLogGroupByName["notification-service"];

export const notificationInbox = new NotificationInbox("notification-inbox", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: notificationLogGroup,
  httpApi,
});

export const notificationDigest = new NotificationDigest("notification-digest", {
  env,
  deptId,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  platformBusName: platformBus.busName,
  platformBusArn: platformBus.busArn,
  sesFromAddress: notificationSesFromAddress,
  logGroup: notificationLogGroup,
});

export const platformConfig = new PlatformConfig("platform-config", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: platformLogGroup,
  httpApi,
});

export const auditRoute = new AuditRoute("audit-route", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  logGroup: platformLogGroup,
  httpApi,
});

export const chiefNotificationTopic = new ChiefNotificationTopic("chief-notifications", { env });

// Apparatus test-due, apparatus defect, consumable reorder and PPE expiry reminders ->
// the digest (and, for an out-of-service defect, the inbox and push at once).
export const notificationReminders = new NotificationReminders("notification-reminders", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  platformBusName: platformBus.busName,
  platformBusArn: platformBus.busArn,
  pushTopicArn: notificationDigest.pushTopic.arn,
  sesFromAddress: notificationSesFromAddress,
  chiefNotificationTopicArn: chiefNotificationTopic.topicArn,
  logGroup: notificationLogGroup,
});

export const platformExport = new Export("platform-export", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  incidentTableName: incidentTable.tableName,
  incidentTableArn: incidentTable.tableArn,
  alertingTableName: alertingTable.tableName,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  incidentCmkArn: incidentTable.cmkArn,
  chiefNotificationTopicArn: chiefNotificationTopic.topicArn,
  logGroup: platformLogGroup,
  httpApi,
});

export const platformRetention = new Retention("platform-retention", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  chiefNotificationTopicArn: chiefNotificationTopic.topicArn,
  logGroup: platformLogGroup,
  httpApi,
});

const incidentServiceLogGroup = serviceLogGroupByName["incident-service"];

export const incidentSchemaRefresh = new SchemaRefresh("incident-schema-refresh", {
  env,
  incidentTableName: incidentTable.tableName,
  incidentTableArn: incidentTable.tableArn,
  incidentCmkArn: incidentTable.cmkArn,
  nerisSchemaSourceUrl,
  logGroup: incidentServiceLogGroup,
});

export const incident = new Incident("incident", {
  env,
  incidentTableName: incidentTable.tableName,
  incidentTableArn: incidentTable.tableArn,
  incidentCmkArn: incidentTable.cmkArn,
  busName: platformBus.busName,
  busArn: platformBus.busArn,
  nerisSchemaBucketArn: incidentSchemaRefresh.bucket.arn,
  nerisSchemaBucketName: incidentSchemaRefresh.bucket.bucket,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: incidentServiceLogGroup,
  httpApi,
});

// Incident-table outbox → platform-bus. The platform OutboxPublisher only reads the
// platform table's stream; without this, incident-service OUTBOX_ENTRY rows are never
// published.
export const incidentOutboxDrain = new IncidentOutboxDrain("incident-outbox-drain", {
  env,
  incidentTableName: incidentTable.tableName,
  incidentTableArn: incidentTable.tableArn,
  incidentTableStreamArn: incidentTable.streamArn,
  incidentCmkArn: incidentTable.cmkArn,
  busName: platformBus.busName,
  busArn: platformBus.busArn,
  logGroup: incidentServiceLogGroup,
});

// NERIS submission worker: consumes neris.incident.submitted off the platform bus and
// schedules its own backoff retries via EventBridge Scheduler.
export const nerisSubmissionWorker = new NerisSubmissionWorker("neris-submission-worker", {
  env,
  incidentTableName: incidentTable.tableName,
  incidentTableArn: incidentTable.tableArn,
  incidentCmkArn: incidentTable.cmkArn,
  busName: platformBus.busName,
  busArn: platformBus.busArn,
  nerisCredentialsSecretArn: nerisConfig.secret.arn,
  logGroup: incidentServiceLogGroup,
});

// E1-S2/S3-INFRA #28/#29: alerting messaging plane — SNS FIFO topic + per-channel SQS
// FIFO queues/DLQs. Shares no resource with the LOB bus.
export const messagingAlerting = new MessagingAlerting("messaging-alerting", { env });

export const escalation = new Escalation("escalation", {
  env,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTopicArn: messagingAlerting.topic.arn,
  alertingTableName: alertingTable.tableName,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

export const fanOut = new FanOut("fan-out", {
  env,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  alertingStreamArn: alertingTable.streamArn,
  alertingTopicArn: messagingAlerting.topic.arn,
  escalation,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

export const channelWorkers = new ChannelWorkers("channel-workers", {
  env,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  channelQueues: messagingAlerting.channelQueues,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S1/S5/S6-INFRA: manual dispatch ingress, response confirmation, roster, detail.
export const routesCore = new RoutesCore("routes-core", {
  env,
  httpApi,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  logGroup: alertingLogGroup,
  escalation,
  policyStoreId: policyStore.policyStoreId,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S4/S8/S9-INFRA: self-test, audit, and provider delivery-receipt routes.
export const routesOps = new RoutesOps("routes-ops", {
  env,
  httpApi,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  logGroup: alertingLogGroup,
  policyStoreId: policyStore.policyStoreId,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// reporting-service: every chief/officer report, CSV/PDF export, and the N1.9 cutover
// decision. Declared after routesOps because GET cutover-decision invokes alerting's
// delivery-baseline Lambda (its only cross-plane dependency).
export const reporting = new Reporting("reporting", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  incidentTableName: incidentTable.tableName,
  incidentTableArn: incidentTable.tableArn,
  incidentCmkArn: incidentTable.cmkArn,
  deliveryBaselineFunctionName: routesOps.deliveryBaseline.lambda.function.name,
  deliveryBaselineFunctionArn: routesOps.deliveryBaseline.lambda.function.arn,
  platformBusName: platformBus.busName,
  platformBusArn: platformBus.busArn,
  chiefNotificationTopicArn: chiefNotificationTopic.topicArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: serviceLogGroupByName["reporting-service"],
  httpApi,
});

// E1-S14-INFRA #39: push-token routes (platform table) + member-updated consumer
// (alerting table only).
export const pushTokens = new PushTokens("push-tokens", {
  env,
  httpApi,
  platformTableArn: platformTable.tableArn,
  platformTableName: platformTable.tableName,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  personnelLogGroup,
  alertingLogGroup,
  policyStoreId: policyStore.policyStoreId,
  busName: platformBus.busName,
  alertingPermissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S18-INFRA #111 (partial — see riding-board.ts for the deviation from the ticket).
export const ridingBoard = new RidingBoard("riding-board", {
  env,
  httpApi,
  platformTableArn: platformTable.tableArn,
  platformTableName: platformTable.tableName,
  logGroup: apparatusLogGroup,
  policyStoreId: policyStore.policyStoreId,
});

// E1-S11-INFRA #36: alerting-page topic, DLQ/failure alarms, non-prod fault injection.
export const alertingAlarms = new AlertingAlarms("alerting-alarms", {
  env,
  channelQueues: messagingAlerting.channelQueues,
  fanOutFunctionName: fanOut.lambda.function.name,
  fanOutOnFailureQueue: fanOut.onFailureQueue,
  escalationFunctionName: escalation.lambda.function.name,
  toneEvaluatorFunctionName: escalation.toneEvaluatorLambda.function.name,
  escalationOnFailureQueue: escalation.onFailureQueue,
  memberUpdatedDlq: pushTokens.memberUpdatedDlq,
  memberUpdatedFunctionName: pushTokens.memberUpdatedConsumer.function.name,
});

// F1.13/F1.14: officer tone-ladder advance/halt and mutual-aid trigger/acknowledge.
// Declared after alertingAlarms so a failed control pages through the alerting-page topic.
export const routesLadderControls = new RoutesLadderControls("routes-ladder-controls", {
  env,
  httpApi,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  alertingTopicArn: messagingAlerting.topic.arn,
  escalation,
  logGroup: alertingLogGroup,
  policyStoreId: policyStore.policyStoreId,
  pageTopicArn: alertingAlarms.pageTopic.arn,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S13-INFRA #38: eligibility-snapshot staleness schedule + alarm.
export const eligibilityStaleness = new EligibilityStaleness("eligibility-staleness", {
  env,
  deptId,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  pageTopicArn: alertingAlarms.pageTopic.arn,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S10-INFRA #230/#35: continuous production canary + on-call escalation alarms.
export const alertingCanary = new AlertingCanary("alerting-canary", {
  env,
  deptId,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  alertingTableName: alertingTable.tableName,
  pageTopicArn: alertingAlarms.pageTopic.arn,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// PR #324 follow-up: alerting-table outbox -> platform-bus bridge (the allow-listed,
// one-way path incident-service's dispatch/roster consumers depend on).
export const alertingOutboxDrain = new AlertingOutboxDrain("alerting-outbox-drain", {
  pageTopicArn: alertingAlarms.pageTopic.arn,
  env,
  alertingTableName: alertingTable.tableName,
  alertingTableArn: alertingTable.tableArn,
  alertingStreamArn: alertingTable.streamArn,
  alertingCmkArn: alertingTable.cmkArn,
  busName: platformBus.busName,
  busArn: platformBus.busArn,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// architecture.md §2/§4.3: GET health/liveness + health/readiness for every service, one
// unauthenticated Lambda per service. Per service rather than one shared Lambda: Lambda has
// no idle cost, so ten cost the same as one per request, and a shared one would have to
// read both planes' tables across the alerting IAM boundary. Readiness reads each service's
// own table only. Alerting's also carries the N1.6 canary signal.
const LOB_HEALTH_ROUTE_PREFIXES: Record<Exclude<ServiceName, "alerting-service">, string> = {
  "platform-service": "/api/v1/platform",
  "personnel-service": "/api/v1/personnel",
  "apparatus-service": "/api/v1/apparatus",
  "incident-service": "/api/v1/incidents",
  "training-service": "/api/v1/training",
  "reporting-service": "/api/v1/reporting",
  "inspections-service": "/api/v1/inspections",
  "inventory-service": "/api/v1/inventory",
  // architecture.md lists a bare /notifications prefix; the deployed inbox lives under
  // /api/v1/notifications (api-gap P1 #11), so its health pair does too.
  "notification-service": "/api/v1/notifications",
};

export const serviceHealth: ServiceHealth[] = [
  new ServiceHealth("alerting-health", {
    env,
    serviceName: "alerting-service",
    routePrefix: "/api/v1/alerting",
    httpApi,
    logGroup: alertingLogGroup,
    tableName: alertingTable.tableName,
    tableArn: alertingTable.tableArn,
    tableCmkArn: alertingTable.cmkArn,
    queryLeadingKeys: [`DEPT#${deptId}#CANARY#*`],
    environment: {
      CANARY_ENABLED: String(alertingCanary.enabled),
      CANARY_DEPT_ID: deptId,
      CANARY_MAX_AGE_SECONDS: String(alertingCanary.maxRunAgeSeconds),
    },
    permissionsBoundaryArn: alertingBoundaryArn,
  }),
  ...(Object.keys(LOB_HEALTH_ROUTE_PREFIXES) as (keyof typeof LOB_HEALTH_ROUTE_PREFIXES)[]).map(
    (serviceName) => {
      const table = serviceName === "incident-service" ? incidentTable : platformTable;
      return new ServiceHealth(`${serviceName.replace(/-service$/, "")}-health`, {
        env,
        serviceName,
        routePrefix: LOB_HEALTH_ROUTE_PREFIXES[serviceName],
        httpApi,
        logGroup: serviceLogGroupByName[serviceName],
        tableName: table.tableName,
        tableArn: table.tableArn,
        tableCmkArn: serviceName === "incident-service" ? incidentTable.cmkArn : undefined,
        eventBus: { name: platformBus.busName, arn: platformBus.busArn },
      });
    },
  ),
];

// Stack outputs for boxalarm-ui / later children.
export const COGNITO_ISSUER = cognitoIssuer;
export const COGNITO_WEB_CLIENT_ID = webUserPoolClient.userPoolClient.id;
export const COGNITO_NATIVE_CLIENT_ID = mobileUserPoolClient.userPoolClient.id;
export const HTTP_API_ENDPOINT = httpApi.apiEndpoint;
export const PLATFORM_TABLE_NAME = platformTable.tableName;
export const INCIDENT_TABLE_NAME = incidentTable.tableName;
export const ALERTING_TABLE_NAME = alertingTable.tableName;
export const VERIFIED_PERMISSIONS_POLICY_STORE_ID = policyStore.policyStoreId;
export const PLATFORM_BUS_NAME = platformBus.busName;
