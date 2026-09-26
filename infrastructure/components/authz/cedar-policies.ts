export const ROLE_GROUPS = [
  "MEMBER",
  "OFFICER",
  "TRAINING",
  "APPARATUS",
  "ADMIN",
  "CHIEF",
] as const;
export type RoleGroup = (typeof ROLE_GROUPS)[number];

// Action IDs are pinned to what @boxalarm/authz's withAuthorization callers actually
// send (grep backend/packages/authz + the withAuthorization call sites), not aspirational
// names — a mismatch here means Verified Permissions can never match a policy for that
// action and the request falls through to the implicit DENY.
//
// RunRecordsDisposal / ViewRetentionConfig / UpdateRetentionConfig / UpdateMember are
// live today (retention/disposalHandler.ts, retention/configHandler.ts,
// members/updateMember.ts). ViewConfig / UpdateConfig / ExportData are not yet called —
// config/handler.ts and export/authz.ts still gate on assertChiefOrAdmin, with a TODO to
// swap to Cedar once this policy store ships — defined ahead of that swap so it isn't a
// companion infra change later. RevokeSession is the same: deviceLossHandler.ts still
// gates on a manual ADMIN_GROUPS check (TODO: E8-S3), defined ahead of time per the
// audit finding that this schema doesn't yet cover session-revocation actions.
export const ADMIN_ONLY_ACTIONS = [
  "UpdateConfig",
  "ExportData",
  "RunRecordsDisposal",
  "ViewRetentionConfig",
  "UpdateRetentionConfig",
  "UpdateMember",
  "RevokeSession",
] as const;
export const ADMIN_ONLY_GROUPS = ["CHIEF", "ADMIN"] as const;

export const VIEW_ACTIONS = ["ViewConfig"] as const;

// E2/E3-INFRA (#204-#221): every action below is what withAuthorization's callers in
// backend/src/services/{personnel,training}-service actually send (grepped, same rule as
// above) — including quals/handler.ts, certifications/*.ts, transcript/get.ts and
// reports/iso.ts, whose actionType/resourceType literals ('PersonnelService', 'Training',
// 'Member', 'TrainingReport') were normalized to the Boxalarm::Action / Boxalarm::<Type>
// convention every other route uses, so one schema can express a policy for all of them.
// decide.ts sends those namespace-qualified type names (Boxalarm::Action,
// Boxalarm::Member, ...) verbatim, and the namespaced schema below only declares
// Boxalarm::-qualified types — an unqualified or unknown type can never match a policy.
export const SELF_SERVICE_ACTIONS = [
  // F2.6 / AP 12: a member editing their OWN profile. updateMember.ts routes a request to
  // this action only when the path memberId is the caller's sub, and re-checks that
  // against the verified principal before writing; editing anyone else is UpdateMember
  // (ADMIN_ONLY_ACTIONS above).
  "SelfUpdateMember",
  "RecordAttendance",
  "ViewOwnAttendance",
  "MarkAvailability",
  "ViewOwnLosapTotal",
  "GetQuals",
  "ViewTranscript",
  "ViewCertifications",
  "ViewTrainingHours",
] as const;

export const OFFICER_TIER_ACTIONS = [
  "RecordAttendanceOnBehalf",
  "ViewAttendanceOnBehalf",
  "ApproveShiftSwap",
  "ListPendingShiftSwaps",
  "CreateTrainingEvent",
  "RecordTrainingAttendance",
  "UpdateQuals",
  "CreateCertification",
  "RevokeCertification",
  "ViewExpiringCertifications",
  "ViewIsoTrainingReport",
  "ViewRosterTrainingHours",
  // PRD §personas: the officer makes riding assignments. ridingBoard/handler.ts
  // (assignRidingPositionHandler) sends this against Boxalarm::RidingBoard.
  "AssignRidingPosition",
] as const;
export const OFFICER_TIER_GROUPS = ["OFFICER", "TRAINING", "CHIEF", "ADMIN"] as const;

// apparatus-service (api-gap P0 #5): the actionIds its withAuthorization callers send
// (grepped from backend/src/services/apparatus-service, pinned by that service's
// cedarActions.test.ts). Tiers follow docs/architecture.md §2's apparatus table: routes
// marked "Cognito" are every-role; "Cognito(admin)" (service-status, compliance) and the
// write routes the table does not list (maintenance log, hose/ladder/pump/aerial test log,
// compartment item create/restock) are the apparatus-officer tier. That tier adds the
// APPARATUS group to the architecture's chief/admin/officer definition of Cognito(admin),
// because §7.1 gives /apparatus and /apparatus/:id to the apparatus role and the
// APPARATUS group exists for exactly this officer.
// Not here: riding-board actions (owned by the riding-board fix), and the three routes
// that authorize without Cedar (list/get read on the dept-scoped authorizer context,
// create on a manual CHIEF/ADMIN group check in authContext.ts).
export const APPARATUS_MEMBER_ACTIONS = [
  "GetChecklist",
  "SubmitApparatusCheck",
  "ReportDefect",
  "ViewMaintenanceHistory",
  "LogScbaRecord",
  "ViewScbaTestingSchedules",
  "ViewTestingSchedules",
  "ListCompartmentInventory",
] as const;

export const APPARATUS_OFFICER_ACTIONS = [
  "UpdateServiceStatus",
  "GetComplianceReport",
  "LogMaintenanceRecord",
  "LogApparatusTestRecord",
  "CreateCompartmentItem",
  "UpdateCompartmentItemQuantity",
] as const;
export const APPARATUS_OFFICER_GROUPS = ["APPARATUS", "OFFICER", "CHIEF", "ADMIN"] as const;

// Resource type each apparatus action is sent with. Every apparatus route passes
// Boxalarm::Apparatus except the SCBA due-soon feed, which is department-wide.
const APPARATUS_ACTION_RESOURCE: Record<
  (typeof APPARATUS_MEMBER_ACTIONS)[number] | (typeof APPARATUS_OFFICER_ACTIONS)[number],
  "Apparatus" | "Department"
> = {
  GetChecklist: "Apparatus",
  SubmitApparatusCheck: "Apparatus",
  ReportDefect: "Apparatus",
  ViewMaintenanceHistory: "Apparatus",
  LogScbaRecord: "Apparatus",
  ViewScbaTestingSchedules: "Department",
  ViewTestingSchedules: "Apparatus",
  ListCompartmentInventory: "Apparatus",
  UpdateServiceStatus: "Apparatus",
  GetComplianceReport: "Apparatus",
  LogMaintenanceRecord: "Apparatus",
  LogApparatusTestRecord: "Apparatus",
  CreateCompartmentItem: "Apparatus",
  UpdateCompartmentItemQuantity: "Apparatus",
};

const APPARATUS_SCHEMA_ACTIONS = Object.fromEntries(
  Object.entries(APPARATUS_ACTION_RESOURCE).map(([action, resourceType]) => [
    action,
    { appliesTo: { principalTypes: ["User"], resourceTypes: [resourceType] } },
  ]),
);

// Department-scoping is NOT expressed here as a `when` clause comparing
// principal/resource attributes. Two things rule that out for every action above:
//   1. @boxalarm/authz's isAuthorized() calls IsAuthorizedWithTokenCommand with the
//      caller's ACCESS token. Per the Verified Permissions docs, access-token claims
//      map to the request's `context`, never to principal entity attributes — only ID
//      tokens populate principal attributes. custom:deptId (the actual claim name) would
//      need to be read via context, not principal.deptId.
//   2. decide.ts's isAuthorized() passes only { entityType, entityId } for the resource,
//      with no `entities` — so a resource attribute (e.g. resource.deptId) is never
//      populated and any `when` clause referencing it evaluates to an error, which Cedar
//      treats as an implicit DENY. This is a structural fact of how the call is built,
//      not a schema problem this policy store can fix on its own.
// Every action above already targets "my own department's resource" — every
// resourceId(event) call site in the backend passes the caller's own verified deptId
// (or a member scoped to it), so a same-department check would be tautological even if
// it could be expressed. CLAUDE.md states the actual design point plainly: "Export and
// destructive actions are gated by Cedar role check alone." Department isolation is
// enforced where CLAUDE.md says it lives — dept-scoped DynamoDB keys built from the
// verified JWT (buildDeptScopedPk) — not duplicated here.
export const CEDAR_SCHEMA = JSON.stringify({
  Boxalarm: {
    entityTypes: {
      User: { memberOfTypes: ["UserGroup"] },
      UserGroup: {},
      // Resource types actually sent as resourceType by withAuthorization callers.
      Department: {},
      Member: {},
      ShiftSwapRequest: {},
      TrainingEvent: {},
      TrainingReport: {},
      RidingBoard: {},
      Apparatus: {},
    },
    actions: {
      ViewConfig: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] } },
      UpdateConfig: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] } },
      ExportData: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] } },
      RunRecordsDisposal: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      ViewRetentionConfig: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      UpdateRetentionConfig: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      UpdateMember: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      SelfUpdateMember: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      RevokeSession: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      RecordAttendance: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      RecordAttendanceOnBehalf: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] },
      },
      ViewOwnAttendance: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      ViewAttendanceOnBehalf: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] },
      },
      MarkAvailability: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      ViewOwnLosapTotal: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      GetQuals: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      UpdateQuals: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      ViewTranscript: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      ViewCertifications: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      CreateCertification: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] },
      },
      RevokeCertification: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] },
      },
      ViewExpiringCertifications: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      ViewIsoTrainingReport: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["TrainingReport"] },
      },
      ViewTrainingHours: { appliesTo: { principalTypes: ["User"], resourceTypes: ["Member"] } },
      ViewRosterTrainingHours: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      CreateTrainingEvent: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      RecordTrainingAttendance: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["TrainingEvent"] },
      },
      ApproveShiftSwap: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["ShiftSwapRequest"] },
      },
      ListPendingShiftSwaps: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["Department"] },
      },
      AssignRidingPosition: {
        appliesTo: { principalTypes: ["User"], resourceTypes: ["RidingBoard"] },
      },
      ...APPARATUS_SCHEMA_ACTIONS,
    },
  },
});

// Cedar's scope clause only accepts an entity LIST for the `action` element — `principal
// in [group1, group2, ...]` is not valid Cedar grammar (only `principal in <single
// entity>` is), so the group check has to move into a `when` clause as an OR of
// individual `in` membership tests. The original `principal in [group1, group2]` form
// here would have failed to parse at CreatePolicy time, not merely evaluated to DENY.

// Verified Permissions Cognito identity sources scope group entity IDs to the pool
// they came from — "<userPoolId>|<groupName>", never the bare group name — since
// Cognito groups are only unique within their own user pool. A policy referencing
// Boxalarm::UserGroup::"CHIEF" literally can never match and every action gated by
// it silently falls through to the implicit DENY. See AWS docs:
// https://docs.aws.amazon.com/verifiedpermissions/latest/userguide/identity-sources-cognito.md
function groupEntityId(userPoolId: string, groupName: string): string {
  return `${userPoolId}|${groupName}`;
}

/** AC1: admin-only actions (config writes, export, disposal, member/session admin) — CHIEF/ADMIN only. */
export function adminActionsPolicy(userPoolId: string): string {
  const groupCheck = ADMIN_ONLY_GROUPS.map(
    (g) => `principal in Boxalarm::UserGroup::"${groupEntityId(userPoolId, g)}"`,
  ).join(" || ");
  const actions = ADMIN_ONLY_ACTIONS.map((a) => `Boxalarm::Action::"${a}"`).join(", ");
  return `permit (\n  principal,\n  action in [${actions}],\n  resource\n) when {\n  ${groupCheck}\n};`;
}

/** Read access for every role (N5.3). */
export function viewConfigPolicy(userPoolId: string): string {
  const groupCheck = ROLE_GROUPS.map(
    (g) => `principal in Boxalarm::UserGroup::"${groupEntityId(userPoolId, g)}"`,
  ).join(" || ");
  const actions = VIEW_ACTIONS.map((a) => `Boxalarm::Action::"${a}"`).join(", ");
  return `permit (\n  principal,\n  action in [${actions}],\n  resource\n) when {\n  ${groupCheck}\n};`;
}

/**
 * Every-role personnel/training actions (E2/E3-INFRA). Two different scopes live here:
 *  - Own-record: attendance, availability, LOSAP total and SelfUpdateMember act on the
 *    caller's own principal.sub (the handler derives it, or rejects a path memberId that is
 *    not the caller's).
 *  - In-department read: GetQuals, ViewCertifications, ViewTranscript and ViewTrainingHours
 *    take an arbitrary path memberId and nothing checks it is the caller's — any member may
 *    read any same-department member's quals, certifications (including attachmentS3Key),
 *    transcript and hours. The architecture's "Cognito" auth on those routes permits that;
 *    the department boundary is enforced by the dept-scoped keys, not by Cedar (see above).
 */
export function selfServiceActionsPolicy(userPoolId: string): string {
  const groupCheck = ROLE_GROUPS.map(
    (g) => `principal in Boxalarm::UserGroup::"${groupEntityId(userPoolId, g)}"`,
  ).join(" || ");
  const actions = SELF_SERVICE_ACTIONS.map((a) => `Boxalarm::Action::"${a}"`).join(", ");
  return `permit (\n  principal,\n  action in [${actions}],\n  resource\n) when {\n  ${groupCheck}\n};`;
}

/** On-behalf-of-others personnel/training actions — duty officer, training officer, or admin tier only. */
export function officerTierActionsPolicy(userPoolId: string): string {
  const groupCheck = OFFICER_TIER_GROUPS.map(
    (g) => `principal in Boxalarm::UserGroup::"${groupEntityId(userPoolId, g)}"`,
  ).join(" || ");
  const actions = OFFICER_TIER_ACTIONS.map((a) => `Boxalarm::Action::"${a}"`).join(", ");
  return `permit (\n  principal,\n  action in [${actions}],\n  resource\n) when {\n  ${groupCheck}\n};`;
}

function roleGatedPolicy(
  userPoolId: string,
  groups: readonly RoleGroup[],
  actions: readonly string[],
): string {
  const groupCheck = groups
    .map((g) => `principal in Boxalarm::UserGroup::"${groupEntityId(userPoolId, g)}"`)
    .join(" || ");
  const actionList = actions.map((a) => `Boxalarm::Action::"${a}"`).join(", ");
  return `permit (\n  principal,\n  action in [${actionList}],\n  resource\n) when {\n  ${groupCheck}\n};`;
}

/** Every-role apparatus actions: checks, defects, and the reads architecture marks "Cognito". */
export function apparatusMemberActionsPolicy(userPoolId: string): string {
  return roleGatedPolicy(userPoolId, ROLE_GROUPS, APPARATUS_MEMBER_ACTIONS);
}

/** Apparatus-officer tier: service status, compliance, and maintenance/test/compartment writes. */
export function apparatusOfficerActionsPolicy(userPoolId: string): string {
  return roleGatedPolicy(userPoolId, APPARATUS_OFFICER_GROUPS, APPARATUS_OFFICER_ACTIONS);
}
