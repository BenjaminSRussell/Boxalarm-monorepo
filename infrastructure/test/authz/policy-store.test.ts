import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:verifiedpermissions/policyStore:PolicyStore") {
        state.policyStoreId = `${args.name}-id`;
        state.arn = `arn:aws:verifiedpermissions::123456789012:policy-store/${args.name}-id`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

describe("PolicyStore", () => {
  async function build() {
    const { PolicyStore } = await import("../../components/authz/policy-store");
    return new PolicyStore("test-policy-store", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      userPoolArn: pulumi.output("arn:aws:cognito-idp:us-east-1:123456789012:userpool/pool-1"),
      allowedClientIds: [pulumi.output("web-client"), pulumi.output("mobile-client")],
    });
  }

  it("creates exactly the six role groups (AC5's four denied roles plus the two allowed)", async () => {
    const store = await build();
    const names = await Promise.all(store.roleGroups.map((g) => resolve(g.name)));
    expect(names.sort()).toEqual(["ADMIN", "APPARATUS", "CHIEF", "MEMBER", "OFFICER", "TRAINING"]);
  });

  it("scopes admin-only actions (export, disposal, UpdateConfig) to CHIEF/ADMIN only (AC1, AC5)", async () => {
    const store = await build();
    const statement = await resolve(store.adminActionsPolicy.definition);
    const text = statement?.static?.statement ?? "";
    // Cognito identity source group entity IDs are "<userPoolId>|<groupName>" — a bare
    // group name never matches, so the pool-id prefix must be present.
    expect(text).toContain('UserGroup::"pool-1|CHIEF"');
    expect(text).toContain('UserGroup::"pool-1|ADMIN"');
    expect(text).not.toContain('UserGroup::"pool-1|MEMBER"');
    expect(text).toContain('Action::"ExportData"');
    // Matches the actionId the backend actually sends (disposalHandler.ts), not the
    // stale "DisposeRecords" name that never matched any real request.
    expect(text).toContain('Action::"RunRecordsDisposal"');
    expect(text).toContain('Action::"UpdateConfig"');
    expect(text).toContain('Action::"ViewRetentionConfig"');
    // No principal/resource attribute comparison: the backend's access-token call maps
    // claims to context (not principal attributes) and passes no resource entities, so
    // a `when` clause referencing either would always error into an implicit DENY. See
    // the comment in cedar-policies.ts for why role gating alone is correct here.
    expect(text).not.toContain("deptId");
    // Group membership is a single-entity `in` check per group, not a scope-clause
    // list (`principal in [g1, g2]` is not valid Cedar grammar for principal/resource).
    expect(text).toContain('principal in Boxalarm::UserGroup::"pool-1|CHIEF"');
    expect(text).toContain('principal in Boxalarm::UserGroup::"pool-1|ADMIN"');
  });

  it("does not grant ViewRetentionConfig to every role (MINOR #6 regression)", async () => {
    const store = await build();
    const view = await resolve(store.viewConfigPolicy.definition);
    expect(view?.static?.statement ?? "").not.toContain('Action::"ViewRetentionConfig"');
  });

  it("evaluates to ALLOW for a CHIEF request built the way decide.ts actually builds it", async () => {
    const { CEDAR_SCHEMA, adminActionsPolicy, viewConfigPolicy } =
      await import("../../components/authz/cedar-policies");
    const { isAuthorized } =
      (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
    const schema = JSON.parse(CEDAR_SCHEMA) as string;
    const entities = [
      {
        uid: { type: "Boxalarm::User", id: "user-1" },
        attrs: {},
        parents: [{ type: "Boxalarm::UserGroup", id: "pool-1|CHIEF" }],
      },
      { uid: { type: "Boxalarm::UserGroup", id: "pool-1|CHIEF" }, attrs: {}, parents: [] },
      { uid: { type: "Boxalarm::Department", id: "dept-1" }, attrs: {}, parents: [] },
    ];

    // decide.ts's isAuthorized() never passes principal/resource entity attributes —
    // only entity ids and group membership, exactly as built here.
    const disposal = isAuthorized({
      principal: { type: "Boxalarm::User", id: "user-1" },
      action: { type: "Boxalarm::Action", id: "RunRecordsDisposal" },
      resource: { type: "Boxalarm::Department", id: "dept-1" },
      context: {},
      schema,
      policies: { staticPolicies: adminActionsPolicy("pool-1") },
      entities,
    });
    expect(disposal.type).toBe("success");
    if (disposal.type === "success") {
      expect(disposal.response.decision).toBe("allow");
    }

    const viewRetention = isAuthorized({
      principal: { type: "Boxalarm::User", id: "user-1" },
      action: { type: "Boxalarm::Action", id: "ViewRetentionConfig" },
      resource: { type: "Boxalarm::Department", id: "dept-1" },
      context: {},
      schema,
      policies: { staticPolicies: adminActionsPolicy("pool-1") },
      entities,
    });
    expect(viewRetention.type).toBe("success");
    if (viewRetention.type === "success") {
      expect(viewRetention.response.decision).toBe("allow");
    }

    const viewConfig = isAuthorized({
      principal: { type: "Boxalarm::User", id: "user-1" },
      action: { type: "Boxalarm::Action", id: "ViewConfig" },
      resource: { type: "Boxalarm::Department", id: "dept-1" },
      context: {},
      schema,
      policies: { staticPolicies: viewConfigPolicy("pool-1") },
      entities,
    });
    expect(viewConfig.type).toBe("success");
    if (viewConfig.type === "success") {
      expect(viewConfig.response.decision).toBe("allow");
    }
  });

  it("evaluates to DENY for a MEMBER requesting an admin-only action", async () => {
    const { CEDAR_SCHEMA, adminActionsPolicy } =
      await import("../../components/authz/cedar-policies");
    const { isAuthorized } =
      (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
    const schema = JSON.parse(CEDAR_SCHEMA) as string;
    const entities = [
      {
        uid: { type: "Boxalarm::User", id: "user-2" },
        attrs: {},
        parents: [{ type: "Boxalarm::UserGroup", id: "pool-1|MEMBER" }],
      },
      { uid: { type: "Boxalarm::UserGroup", id: "pool-1|MEMBER" }, attrs: {}, parents: [] },
      { uid: { type: "Boxalarm::Department", id: "dept-1" }, attrs: {}, parents: [] },
    ];
    const result = isAuthorized({
      principal: { type: "Boxalarm::User", id: "user-2" },
      action: { type: "Boxalarm::Action", id: "RunRecordsDisposal" },
      resource: { type: "Boxalarm::Department", id: "dept-1" },
      context: {},
      schema,
      policies: { staticPolicies: adminActionsPolicy("pool-1") },
      entities,
    });
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.response.decision).toBe("deny");
    }
  });

  // CRIT-1 (#327 review): the personnel/training policies must use the same
  // "<userPoolId>|<group>" ids the Cognito identity source produces, or every one of
  // their actions falls through to the implicit DENY.
  describe("personnel/training policies (self-service and officer tier)", () => {
    async function decideFor(
      group: string,
      action: string,
      resource: { type: string; id: string },
      policy: "self" | "officer",
    ): Promise<string> {
      const { CEDAR_SCHEMA, selfServiceActionsPolicy, officerTierActionsPolicy } =
        await import("../../components/authz/cedar-policies");
      const { isAuthorized } =
        (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
      const groupId = `pool-1|${group}`;
      const result = isAuthorized({
        principal: { type: "Boxalarm::User", id: "pool-1|user-1" },
        action: { type: "Boxalarm::Action", id: action },
        resource,
        context: {},
        schema: JSON.parse(CEDAR_SCHEMA) as string,
        policies: {
          staticPolicies:
            policy === "self"
              ? selfServiceActionsPolicy("pool-1")
              : officerTierActionsPolicy("pool-1"),
        },
        entities: [
          {
            uid: { type: "Boxalarm::User", id: "pool-1|user-1" },
            attrs: {},
            parents: [{ type: "Boxalarm::UserGroup", id: groupId }],
          },
          { uid: { type: "Boxalarm::UserGroup", id: groupId }, attrs: {}, parents: [] },
          { uid: resource, attrs: {}, parents: [] },
        ],
      });
      expect(result.type).toBe("success");
      return result.type === "success" ? result.response.decision : "error";
    }

    const member = { type: "Boxalarm::Member", id: "member-1" };
    const dept = { type: "Boxalarm::Department", id: "dept-1" };

    it("builds pool-qualified group ids, never bare group names", async () => {
      const store = await build();
      const [self, officer] = await Promise.all([
        resolve(store.selfServiceActionsPolicy.definition),
        resolve(store.officerTierActionsPolicy.definition),
        resolve(store.alertingMemberActionsPolicy.definition),
        resolve(store.alertingOfficerActionsPolicy.definition),
      ]);
      expect(self?.static?.statement).toContain('UserGroup::"pool-1|MEMBER"');
      expect(self?.static?.statement).not.toContain('UserGroup::"MEMBER"');
      expect(officer?.static?.statement).toContain('UserGroup::"pool-1|OFFICER"');
      expect(officer?.static?.statement).not.toContain('UserGroup::"OFFICER"');
      expect(officer?.static?.statement).not.toContain('"pool-1|MEMBER"');
    });

    it.each(["GetQuals", "MarkAvailability", "ViewTranscript", "RecordAttendance"])(
      "ALLOWs a MEMBER on self-service action %s",
      async (action) => {
        expect(await decideFor("MEMBER", action, member, "self")).toBe("allow");
      },
    );

    it.each(["OFFICER", "CHIEF", "TRAINING", "ADMIN"])(
      "ALLOWs %s on officer-tier actions",
      async (group) => {
        expect(await decideFor(group, "UpdateQuals", member, "officer")).toBe("allow");
        expect(await decideFor(group, "ViewExpiringCertifications", dept, "officer")).toBe("allow");
        expect(
          await decideFor(
            group,
            "RecordTrainingAttendance",
            { type: "Boxalarm::TrainingEvent", id: "evt-1" },
            "officer",
          ),
        ).toBe("allow");
      },
    );

    it("ALLOWs a MEMBER SelfUpdateMember but keeps UpdateMember (another member) admin-only", async () => {
      const { CEDAR_SCHEMA, adminActionsPolicy, selfServiceActionsPolicy } =
        await import("../../components/authz/cedar-policies");
      const { isAuthorized } =
        (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
      const decide = (action: string) => {
        const result = isAuthorized({
          principal: { type: "Boxalarm::User", id: "pool-1|user-1" },
          action: { type: "Boxalarm::Action", id: action },
          resource: member,
          context: {},
          schema: JSON.parse(CEDAR_SCHEMA) as string,
          policies: {
            staticPolicies: `${selfServiceActionsPolicy("pool-1")}\n${adminActionsPolicy("pool-1")}`,
          },
          entities: [
            {
              uid: { type: "Boxalarm::User", id: "pool-1|user-1" },
              attrs: {},
              parents: [{ type: "Boxalarm::UserGroup", id: "pool-1|MEMBER" }],
            },
            { uid: { type: "Boxalarm::UserGroup", id: "pool-1|MEMBER" }, attrs: {}, parents: [] },
            { uid: member, attrs: {}, parents: [] },
          ],
        });
        return result.type === "success" ? result.response.decision : "error";
      };
      expect(decide("SelfUpdateMember")).toBe("allow");
      expect(decide("UpdateMember")).toBe("deny");
    });

    // The riding-board assign route was deployed with an action the schema didn't declare,
    // so every seat assignment was an implicit DENY.
    const ridingBoard = { type: "Boxalarm::RidingBoard", id: "dispatch-1" };

    it.each(["OFFICER", "CHIEF", "TRAINING", "ADMIN"])(
      "ALLOWs %s to assign a riding position",
      async (group) => {
        expect(await decideFor(group, "AssignRidingPosition", ridingBoard, "officer")).toBe(
          "allow",
        );
      },
    );

    it.each(["MEMBER", "APPARATUS"])("DENYs %s on officer-tier actions", async (group) => {
      expect(await decideFor(group, "AssignRidingPosition", ridingBoard, "officer")).toBe("deny");
      expect(await decideFor(group, "UpdateQuals", member, "officer")).toBe("deny");
      expect(await decideFor(group, "RevokeCertification", member, "officer")).toBe("deny");
      expect(await decideFor(group, "ViewRosterTrainingHours", dept, "officer")).toBe("deny");
    });

    // notification-service inbox + preferences: own-record self-service for every role.
    const notification = { type: "Boxalarm::Notification", id: "notif-1" };
    const NOTIFICATION_ACTIONS: [string, { type: string; id: string }][] = [
      ["ViewOwnNotifications", member],
      ["MarkNotificationRead", notification],
      ["ViewOwnNotificationPreferences", member],
      ["UpdateOwnNotificationPreferences", member],
    ];

    it.each(["MEMBER", "OFFICER", "TRAINING", "APPARATUS", "ADMIN", "CHIEF"])(
      "ALLOWs %s every notification inbox/preferences action",
      async (group) => {
        for (const [action, resource] of NOTIFICATION_ACTIONS) {
          expect(await decideFor(group, action, resource, "self"), action).toBe("allow");
        }
      },
    );

    it("DENYs notification actions to a principal in no Boxalarm role group", async () => {
      for (const [action, resource] of NOTIFICATION_ACTIONS) {
        expect(await decideFor("SOME_OTHER_GROUP", action, resource, "self"), action).toBe("deny");
      }
    });

    it("DENYs notification actions under the officer-tier policy alone (they live only in self-service)", async () => {
      for (const [action, resource] of NOTIFICATION_ACTIONS) {
        expect(await decideFor("CHIEF", action, resource, "officer"), action).toBe("deny");
      }
    });

    it("DENYs a notification action whose ids use the bare group name (the pre-fix form)", async () => {
      const { CEDAR_SCHEMA, selfServiceActionsPolicy } =
        await import("../../components/authz/cedar-policies");
      const { isAuthorized } =
        (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
      const result = isAuthorized({
        principal: { type: "Boxalarm::User", id: "u" },
        action: { type: "Boxalarm::Action", id: "ViewOwnNotifications" },
        resource: member,
        context: {},
        schema: JSON.parse(CEDAR_SCHEMA) as string,
        policies: { staticPolicies: selfServiceActionsPolicy("pool-1") },
        entities: [
          {
            uid: { type: "Boxalarm::User", id: "u" },
            attrs: {},
            parents: [{ type: "Boxalarm::UserGroup", id: "MEMBER" }],
          },
          { uid: { type: "Boxalarm::UserGroup", id: "MEMBER" }, attrs: {}, parents: [] },
          { uid: member, attrs: {}, parents: [] },
        ],
      });
      expect(result.type === "success" && result.response.decision).toBe("deny");
    });

    it("DENYs a MEMBER whose group id is the bare name (the pre-fix form)", async () => {
      const { CEDAR_SCHEMA, selfServiceActionsPolicy } =
        await import("../../components/authz/cedar-policies");
      const { isAuthorized } =
        (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
      const result = isAuthorized({
        principal: { type: "Boxalarm::User", id: "u" },
        action: { type: "Boxalarm::Action", id: "GetQuals" },
        resource: member,
        context: {},
        schema: JSON.parse(CEDAR_SCHEMA) as string,
        policies: { staticPolicies: selfServiceActionsPolicy("pool-1") },
        entities: [
          {
            uid: { type: "Boxalarm::User", id: "u" },
            attrs: {},
            parents: [{ type: "Boxalarm::UserGroup", id: "MEMBER" }],
          },
          { uid: { type: "Boxalarm::UserGroup", id: "MEMBER" }, attrs: {}, parents: [] },
          { uid: member, attrs: {}, parents: [] },
        ],
      });
      expect(result.type === "success" && result.response.decision).toBe("deny");
    });
  });

  // api-gap P0-6: inventory-service actions. An action or resource type missing from the
  // schema is an implicit DENY in Verified Permissions, so each one is evaluated here
  // against the real schema with cedar-wasm, the way decide.ts builds the request.
  describe("inventory policies (read: every role; write: chief/admin/officer)", () => {
    const dept = { type: "Boxalarm::Department", id: "dept-1" };
    const asset = { type: "Boxalarm::Asset", id: "asset-1" };
    const member = { type: "Boxalarm::Member", id: "member-1" };
    const RESOURCE: Record<string, { type: string; id: string }> = {
      ListEquipment: dept,
      ViewEquipmentAsset: asset,
      ListConsumables: dept,
      ViewPpeAssignments: member,
      RegisterEquipmentAsset: dept,
      AssignEquipmentAsset: asset,
      SetEquipmentLocation: asset,
      TransitionAssetLifecycle: asset,
      IssuePpeAssignment: member,
    };

    async function decide(
      group: string,
      action: string,
      groupId = `pool-1|${group}`,
    ): Promise<string> {
      const { CEDAR_SCHEMA, inventoryReadActionsPolicy, inventoryAdminActionsPolicy } =
        await import("../../components/authz/cedar-policies");
      const { isAuthorized } =
        (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
      const resource = RESOURCE[action]!;
      const result = isAuthorized({
        principal: { type: "Boxalarm::User", id: "pool-1|user-1" },
        action: { type: "Boxalarm::Action", id: action },
        resource,
        context: {},
        schema: JSON.parse(CEDAR_SCHEMA) as string,
        policies: {
          staticPolicies: `${inventoryReadActionsPolicy("pool-1")}\n${inventoryAdminActionsPolicy("pool-1")}`,
        },
        entities: [
          {
            uid: { type: "Boxalarm::User", id: "pool-1|user-1" },
            attrs: {},
            parents: [{ type: "Boxalarm::UserGroup", id: groupId }],
          },
          { uid: { type: "Boxalarm::UserGroup", id: groupId }, attrs: {}, parents: [] },
          { uid: resource, attrs: {}, parents: [] },
        ],
      });
      expect(result.type, JSON.stringify(result)).toBe("success");
      return result.type === "success" ? result.response.decision : "error";
    }

    it("declares every inventory action (and the Asset type) in the schema", async () => {
      const { CEDAR_SCHEMA, INVENTORY_READ_ACTIONS, INVENTORY_ADMIN_ACTIONS } =
        await import("../../components/authz/cedar-policies");
      const schema = JSON.parse(CEDAR_SCHEMA) as {
        Boxalarm: { entityTypes: Record<string, unknown>; actions: Record<string, unknown> };
      };
      expect(schema.Boxalarm.entityTypes).toHaveProperty("Asset");
      for (const action of [...INVENTORY_READ_ACTIONS, ...INVENTORY_ADMIN_ACTIONS]) {
        expect(schema.Boxalarm.actions, action).toHaveProperty(action);
        expect(RESOURCE, action).toHaveProperty(action);
      }
    });

    it.each(["MEMBER", "OFFICER", "TRAINING", "APPARATUS", "ADMIN", "CHIEF"])(
      "ALLOWs %s every inventory read",
      async (group) => {
        for (const action of [
          "ListEquipment",
          "ViewEquipmentAsset",
          "ListConsumables",
          "ViewPpeAssignments",
        ]) {
          expect(await decide(group, action), action).toBe("allow");
        }
      },
    );

    const WRITES = [
      "RegisterEquipmentAsset",
      "AssignEquipmentAsset",
      "SetEquipmentLocation",
      "TransitionAssetLifecycle",
      "IssuePpeAssignment",
    ];

    it.each(["OFFICER", "CHIEF", "ADMIN"])("ALLOWs %s every inventory write", async (group) => {
      for (const action of WRITES) {
        expect(await decide(group, action), action).toBe("allow");
      }
    });

    it.each(["MEMBER", "TRAINING", "APPARATUS"])(
      "DENYs %s every inventory write",
      async (group) => {
        for (const action of WRITES) {
          expect(await decide(group, action), action).toBe("deny");
        }
      },
    );

    it("DENYs a CHIEF whose group id is the bare name (the pre-#361 form)", async () => {
      expect(await decide("CHIEF", "ListEquipment", "CHIEF")).toBe("deny");
      expect(await decide("CHIEF", "RegisterEquipmentAsset", "CHIEF")).toBe("deny");
    });

    it("builds pool-qualified group ids, never bare group names", async () => {
      const store = await build();
      const [read, write] = await Promise.all([
        resolve(store.inventoryReadActionsPolicy.definition),
        resolve(store.inventoryAdminActionsPolicy.definition),
      ]);
      expect(read?.static?.statement).toContain('UserGroup::"pool-1|MEMBER"');
      expect(write?.static?.statement).toContain('UserGroup::"pool-1|OFFICER"');
      expect(write?.static?.statement).not.toContain('"pool-1|MEMBER"');
      expect(write?.static?.statement).not.toContain('UserGroup::"CHIEF"');
    });
  });

  // Every alerting + push-token action was undeclared, so STRICT validation failed them all.
  describe("alerting policies (every-role and chief/admin/officer)", () => {
    async function decide(
      group: string,
      action: string,
      resource: { type: string; id: string },
    ): Promise<string> {
      const { CEDAR_SCHEMA, alertingMemberActionsPolicy, alertingOfficerActionsPolicy } =
        await import("../../components/authz/cedar-policies");
      const { isAuthorized } =
        (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
      const groupId = `pool-1|${group}`;
      const result = isAuthorized({
        principal: { type: "Boxalarm::User", id: "pool-1|user-1" },
        action: { type: "Boxalarm::Action", id: action },
        resource,
        context: {},
        schema: JSON.parse(CEDAR_SCHEMA) as string,
        policies: {
          staticPolicies: `${alertingMemberActionsPolicy("pool-1")}\n${alertingOfficerActionsPolicy("pool-1")}`,
        },
        entities: [
          {
            uid: { type: "Boxalarm::User", id: "pool-1|user-1" },
            attrs: {},
            parents: [{ type: "Boxalarm::UserGroup", id: groupId }],
          },
          { uid: { type: "Boxalarm::UserGroup", id: groupId }, attrs: {}, parents: [] },
          { uid: resource, attrs: {}, parents: [] },
        ],
      });
      expect(result.type).toBe("success");
      return result.type === "success" ? result.response.decision : "error";
    }

    const dispatch = { type: "Boxalarm::Dispatch", id: "NICHOLS-1" };
    const member = { type: "Boxalarm::Member", id: "user-1" };
    const dept = { type: "Boxalarm::Department", id: "NICHOLS" };

    it.each(["MEMBER", "OFFICER", "TRAINING", "APPARATUS", "CHIEF", "ADMIN"])(
      "ALLOWs %s to respond, see the roster, self-test and register a push token",
      async (group) => {
        expect(await decide(group, "RecordResponse", dispatch)).toBe("allow");
        expect(await decide(group, "ViewRoster", dispatch)).toBe("allow");
        expect(await decide(group, "SelfTestAlertPath", member)).toBe("allow");
        expect(await decide(group, "RegisterPushToken", member)).toBe("allow");
        expect(await decide(group, "ViewAlertDetail", dept)).toBe("allow");
      },
    );

    it.each(["OFFICER", "CHIEF", "ADMIN"])(
      "ALLOWs %s on manual dispatch, receipts and the audit log",
      async (group) => {
        expect(await decide(group, "SubmitManualDispatch", dept)).toBe("allow");
        expect(await decide(group, "GetDeliveryReceipts", dispatch)).toBe("allow");
        expect(await decide(group, "ViewAlertingAuditLog", dept)).toBe("allow");
      },
    );

    it.each(["MEMBER", "TRAINING", "APPARATUS"])(
      "DENYs %s manual dispatch, receipts and the audit log",
      async (group) => {
        expect(await decide(group, "SubmitManualDispatch", dept)).toBe("deny");
        expect(await decide(group, "GetDeliveryReceipts", dispatch)).toBe("deny");
        expect(await decide(group, "ViewAlertingAuditLog", dept)).toBe("deny");
        expect(await decide(group, "ViewDiagnostics", dispatch)).toBe("deny");
      },
    );
  });

  // inspections-service (F6): every action its handlers send must be in the schema and
  // permitted to the tier architecture.md's route table gives it, else it is an implicit DENY.
  describe("inspections policies (every-role reads/field work, officer-tier writes)", () => {
    const RESOURCE_BY_ACTION: Record<string, { type: string; id: string }> = {
      GetPrePlan: { type: "Boxalarm::Occupancy", id: "OCC-1" },
      UpdatePrePlan: { type: "Boxalarm::Occupancy", id: "OCC-1" },
      WriteOccupancy: { type: "Boxalarm::Occupancy", id: "OCC-1" },
      CreateHydrant: { type: "Boxalarm::Hydrant", id: "hydrants" },
      UpdateHydrant: { type: "Boxalarm::Hydrant", id: "HYD-1" },
      ListInspections: { type: "Boxalarm::InspectionList", id: "dept-1" },
      ScheduleInspection: { type: "Boxalarm::Inspection", id: "OCC-1" },
      ConductInspection: { type: "Boxalarm::Inspection", id: "INS-1" },
      SubmitFieldCapture: { type: "Boxalarm::Inspection", id: "OCC-1" },
      ViewInspectionsMap: { type: "Boxalarm::InspectionsMap", id: "dept-1" },
    };

    async function decide(groupId: string, action: string): Promise<string> {
      const { CEDAR_SCHEMA, inspectionsMemberActionsPolicy, inspectionsOfficerActionsPolicy } =
        await import("../../components/authz/cedar-policies");
      const { isAuthorized } =
        (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
      const resource = RESOURCE_BY_ACTION[action]!;
      const result = isAuthorized({
        principal: { type: "Boxalarm::User", id: "pool-1|user-1" },
        action: { type: "Boxalarm::Action", id: action },
        resource,
        context: {},
        schema: JSON.parse(CEDAR_SCHEMA) as string,
        policies: {
          staticPolicies: `${inspectionsMemberActionsPolicy("pool-1")}\n${inspectionsOfficerActionsPolicy("pool-1")}`,
        },
        entities: [
          {
            uid: { type: "Boxalarm::User", id: "pool-1|user-1" },
            attrs: {},
            parents: [{ type: "Boxalarm::UserGroup", id: groupId }],
          },
          { uid: { type: "Boxalarm::UserGroup", id: groupId }, attrs: {}, parents: [] },
          { uid: resource, attrs: {}, parents: [] },
        ],
      });
      expect(result.type, JSON.stringify(result)).toBe("success");
      return result.type === "success" ? result.response.decision : "error";
    }

    const MEMBER_ACTIONS = [
      "GetPrePlan",
      "ListInspections",
      "ViewInspectionsMap",
      "ScheduleInspection",
      "ConductInspection",
      "SubmitFieldCapture",
    ];
    const OFFICER_ACTIONS = ["WriteOccupancy", "UpdatePrePlan", "CreateHydrant", "UpdateHydrant"];
    const ALL_GROUPS = ["MEMBER", "OFFICER", "TRAINING", "APPARATUS", "ADMIN", "CHIEF"];

    it.each(MEMBER_ACTIONS.flatMap((a) => ALL_GROUPS.map((g) => [a, g])))(
      "ALLOWs %s for %s (every role)",
      async (action, group) => {
        expect(await decide(`pool-1|${group}`, action)).toBe("allow");
      },
    );

    it.each(OFFICER_ACTIONS.flatMap((a) => ["OFFICER", "CHIEF", "ADMIN"].map((g) => [a, g])))(
      "ALLOWs %s for %s",
      async (action, group) => {
        expect(await decide(`pool-1|${group}`, action)).toBe("allow");
      },
    );

    it.each(OFFICER_ACTIONS.flatMap((a) => ["MEMBER", "TRAINING", "APPARATUS"].map((g) => [a, g])))(
      "DENYs %s for %s",
      async (action, group) => {
        expect(await decide(`pool-1|${group}`, action)).toBe("deny");
      },
    );

    it.each([...MEMBER_ACTIONS, ...OFFICER_ACTIONS])(
      "DENYs %s for a bare, pool-unqualified group id",
      async (action) => {
        expect(await decide("CHIEF", action)).toBe("deny");
      },
    );

    it("builds pool-qualified group ids and keeps MEMBER out of the write tier", async () => {
      const store = await build();
      const [member, officer] = await Promise.all([
        resolve(store.inspectionsMemberActionsPolicy.definition),
        resolve(store.inspectionsOfficerActionsPolicy.definition),
      ]);
      expect(member?.static?.statement).toContain('UserGroup::"pool-1|MEMBER"');
      expect(officer?.static?.statement).toContain('UserGroup::"pool-1|OFFICER"');
      expect(officer?.static?.statement).not.toContain('"pool-1|MEMBER"');
      expect(officer?.static?.statement).not.toContain('"pool-1|TRAINING"');
      expect(`${member?.static?.statement}${officer?.static?.statement}`).not.toContain(
        'UserGroup::"CHIEF"',
      );
    });

    // Every Cedar action id the inspections-service source sends must be declared in the
    // schema — an undeclared action is an implicit DENY that no policy can fix.
    it("declares every action id inspections-service handlers send, with the Boxalarm::Action type", async () => {
      const { readdirSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { CEDAR_SCHEMA } = await import("../../components/authz/cedar-policies");
      const root = join(__dirname, "../../../backend/src/services/inspections-service");
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(join(dir, entry.name))
            : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
              ? [join(dir, entry.name)]
              : [],
        );
      const source = walk(root)
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");
      const sent = new Set(
        [
          ...source.matchAll(/actionId:\s*'([^']+)'/g),
          ...source.matchAll(/_ACTION_ID\s*=\s*'([^']+)'/g),
        ].map((m) => m[1]!),
      );
      const actionTypes = new Set(
        [
          ...source.matchAll(/actionType:\s*'([^']+)'/g),
          ...source.matchAll(/_ACTION_TYPE\s*=\s*'([^']+)'/g),
        ].map((m) => m[1]!),
      );
      const declared = Object.keys(
        (JSON.parse(CEDAR_SCHEMA) as { Boxalarm: { actions: Record<string, unknown> } }).Boxalarm
          .actions,
      );
      expect([...sent].sort()).toEqual([...MEMBER_ACTIONS, ...OFFICER_ACTIONS].sort());
      expect([...sent].filter((a) => !declared.includes(a))).toEqual([]);
      expect([...actionTypes]).toEqual(["Boxalarm::Action"]);

      const resourceTypes = new Set(
        [
          ...source.matchAll(/resourceType:\s*'([^']+)'/g),
          ...source.matchAll(/_RESOURCE_TYPE\s*=\s*'([^']+)'/g),
        ].map((m) => m[1]!),
      );
      const entityTypes = Object.keys(
        (JSON.parse(CEDAR_SCHEMA) as { Boxalarm: { entityTypes: Record<string, unknown> } })
          .Boxalarm.entityTypes,
      ).map((t) => `Boxalarm::${t}`);
      expect(resourceTypes.size).toBeGreaterThan(0);
      expect([...resourceTypes].filter((t) => !entityTypes.includes(t))).toEqual([]);
    });
  });

  // P1 #8: every reporting handler's actionId, evaluated against the real schema and the
  // policies PolicyStore deploys. Before this, none of them was declared, so even the three
  // already-deployed reporting routes were an implicit DENY for every caller.
  describe("reporting-service actions", () => {
    const dept = { type: "Boxalarm::Department", id: "dept-1" };
    const READS = [
      "ViewOperationalDashboard",
      "GetLosapYearEnd",
      "ViewIsoReport",
      "ViewGrantsReport",
      "ViewResponseTimes",
      "ViewMembershipTrends",
      "ViewCutoverDecision",
    ];
    const ADMIN_WRITES = ["ExportReport", "RecordCutoverDecision"];

    async function decideAll(group: string, action: string): Promise<string> {
      const {
        CEDAR_SCHEMA,
        adminActionsPolicy,
        viewConfigPolicy,
        selfServiceActionsPolicy,
        officerTierActionsPolicy,
      } = await import("../../components/authz/cedar-policies");
      const { isAuthorized } =
        (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
      const groupId = `pool-1|${group}`;
      const result = isAuthorized({
        principal: { type: "Boxalarm::User", id: "pool-1|user-1" },
        action: { type: "Boxalarm::Action", id: action },
        resource: dept,
        context: {},
        schema: JSON.parse(CEDAR_SCHEMA) as string,
        // All four deployed policies together, as the store evaluates them.
        policies: {
          staticPolicies: [
            adminActionsPolicy("pool-1"),
            viewConfigPolicy("pool-1"),
            selfServiceActionsPolicy("pool-1"),
            officerTierActionsPolicy("pool-1"),
          ].join("\n"),
        },
        entities: [
          {
            uid: { type: "Boxalarm::User", id: "pool-1|user-1" },
            attrs: {},
            parents: [{ type: "Boxalarm::UserGroup", id: groupId }],
          },
          { uid: { type: "Boxalarm::UserGroup", id: groupId }, attrs: {}, parents: [] },
          { uid: dept, attrs: {}, parents: [] },
        ],
        validateRequest: true,
      });
      expect(result.type).toBe("success");
      return result.type === "success" ? result.response.decision : "error";
    }

    it("declares every reporting action in the schema against Boxalarm::Department", async () => {
      const { CEDAR_SCHEMA } = await import("../../components/authz/cedar-policies");
      const actions = (
        JSON.parse(CEDAR_SCHEMA) as {
          Boxalarm: {
            actions: Record<string, { appliesTo: { resourceTypes: string[] } }>;
          };
        }
      ).Boxalarm.actions;
      for (const action of [...READS, ...ADMIN_WRITES]) {
        expect(actions[action]?.appliesTo.resourceTypes, action).toEqual(["Department"]);
      }
    });

    it.each(["OFFICER", "TRAINING", "CHIEF", "ADMIN"])(
      "ALLOWs %s every reporting read",
      async (group) => {
        for (const action of READS) {
          expect(await decideAll(group, action), action).toBe("allow");
        }
      },
    );

    it.each(["MEMBER", "APPARATUS"])("DENYs %s every reporting read", async (group) => {
      for (const action of READS) {
        expect(await decideAll(group, action), action).toBe("deny");
      }
    });

    it.each(["CHIEF", "ADMIN"])("ALLOWs %s export and the cutover decision", async (group) => {
      for (const action of ADMIN_WRITES) {
        expect(await decideAll(group, action), action).toBe("allow");
      }
    });

    it.each(["OFFICER", "TRAINING", "MEMBER", "APPARATUS"])(
      "DENYs %s export and the cutover decision",
      async (group) => {
        for (const action of ADMIN_WRITES) {
          expect(await decideAll(group, action), action).toBe("deny");
        }
      },
    );
  });

  it("every action any policy grants is declared in the schema (no silent implicit DENY)", async () => {
    const {
      CEDAR_SCHEMA,
      ADMIN_ONLY_ACTIONS,
      VIEW_ACTIONS,
      SELF_SERVICE_ACTIONS,
      OFFICER_TIER_ACTIONS,
    } = await import("../../components/authz/cedar-policies");
    const declared = Object.keys(
      (JSON.parse(CEDAR_SCHEMA) as { Boxalarm: { actions: Record<string, unknown> } }).Boxalarm
        .actions,
    );
    for (const action of [
      ...ADMIN_ONLY_ACTIONS,
      ...VIEW_ACTIONS,
      ...SELF_SERVICE_ACTIONS,
      ...OFFICER_TIER_ACTIONS,
    ]) {
      expect(declared, action).toContain(action);
    }
  });

  it("sets principalEntityType so Cognito principals resolve to Boxalarm::User", async () => {
    const store = await build();
    const principalEntityType = await resolve(store.identitySource.principalEntityType);
    expect(principalEntityType).toBe("Boxalarm::User");
  });

  it("declares no permit-all / default-allow policy — only role-gated statements (AC4 fail-secure)", async () => {
    const store = await build();
    const defs = await Promise.all([
      resolve(store.adminActionsPolicy.definition),
      resolve(store.viewConfigPolicy.definition),
      resolve(store.selfServiceActionsPolicy.definition),
      resolve(store.officerTierActionsPolicy.definition),
      resolve(store.inventoryReadActionsPolicy.definition),
      resolve(store.inventoryAdminActionsPolicy.definition),
      resolve(store.inspectionsMemberActionsPolicy.definition),
      resolve(store.inspectionsOfficerActionsPolicy.definition),
    ]);
    for (const def of defs) {
      expect(def?.static?.statement).not.toMatch(
        /permit\s*\(\s*principal\s*,\s*action\s*,\s*resource\s*\)\s*;/,
      );
    }
  });

  it("maps Cognito groups to the Boxalarm::UserGroup entity type on the identity source", async () => {
    const store = await build();
    const config = await resolve(store.identitySource.configuration);
    expect(config?.cognitoUserPoolConfiguration?.groupConfiguration?.groupEntityType).toBe(
      "Boxalarm::UserGroup",
    );
  });

  it("throws on absent or unknown env", async () => {
    const { PolicyStore } = await import("../../components/authz/policy-store");
    expect(
      () =>
        new PolicyStore("test-policy-store-bad", {
          env: "",
          userPoolId: pulumi.output("pool-1"),
          userPoolArn: pulumi.output("arn:aws:cognito-idp:us-east-1:123456789012:userpool/pool-1"),
          allowedClientIds: [pulumi.output("web-client")],
        }),
    ).toThrow(/env is required/);
  });
});
