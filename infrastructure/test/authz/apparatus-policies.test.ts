import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import {
  APPARATUS_MEMBER_ACTIONS,
  APPARATUS_OFFICER_ACTIONS,
  CEDAR_SCHEMA,
  ROLE_GROUPS,
  apparatusMemberActionsPolicy,
  apparatusOfficerActionsPolicy,
} from "../../components/authz/cedar-policies";

/**
 * api-gap P0 #5: the apparatus-service Cedar actions. Every action a deployed apparatus
 * route sends must be in the schema and granted by a role-gated policy — a missing
 * action is an implicit DENY that no unit test in backend/ can see.
 */

const APPARATUS_SRC = path.resolve(__dirname, "../../../backend/src/services/apparatus-service");

interface SourceCedarRef {
  file: string;
  actionType: string;
  actionId: string;
  resourceType: string;
}

/** Every withAuthorization(...) option block in apparatus-service route handlers. */
function sourceCedarRefs(): SourceCedarRef[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The riding board's RidingBoard::AssignRidingPosition is owned by a separate fix.
        if (entry.name !== "ridingBoard") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        files.push(full);
      }
    }
  };
  walk(APPARATUS_SRC);
  const refs: SourceCedarRef[] = [];
  const pattern = /actionType:\s*'([^']+)',\s*actionId:\s*'([^']+)',\s*resourceType:\s*'([^']+)'/g;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      refs.push({
        file: path.relative(APPARATUS_SRC, file),
        actionType: match[1]!,
        actionId: match[2]!,
        resourceType: match[3]!,
      });
    }
  }
  return refs;
}

type Decision = "allow" | "deny" | "error";

async function decide(
  group: string,
  action: string,
  resource: { type: string; id: string },
): Promise<Decision> {
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
      staticPolicies: `${apparatusMemberActionsPolicy("pool-1")}\n${apparatusOfficerActionsPolicy("pool-1")}`,
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
  return result.type === "success" ? result.response.decision : "error";
}

const refs = sourceCedarRefs();
const resourceFor = (actionId: string) => {
  const ref = refs.find((r) => r.actionId === actionId);
  return { type: ref?.resourceType ?? "missing", id: "ENGINE-2" };
};

describe("apparatus-service Cedar schema and policies", () => {
  it("finds the apparatus route handlers' Cedar references in backend source", () => {
    expect(refs.length).toBe(APPARATUS_MEMBER_ACTIONS.length + APPARATUS_OFFICER_ACTIONS.length);
  });

  it("every handler action is declared in the schema for the resource type it sends", () => {
    const schema = JSON.parse(CEDAR_SCHEMA) as {
      Boxalarm: {
        entityTypes: Record<string, unknown>;
        actions: Record<string, { appliesTo: { resourceTypes: string[] } }>;
      };
    };
    for (const ref of refs) {
      expect(ref.actionType, ref.file).toBe("Boxalarm::Action");
      const resourceType = ref.resourceType.replace(/^Boxalarm::/, "");
      expect(ref.resourceType, ref.file).toBe(`Boxalarm::${resourceType}`);
      expect(schema.Boxalarm.entityTypes[resourceType], ref.file).toBeDefined();
      expect(schema.Boxalarm.actions[ref.actionId]?.appliesTo.resourceTypes, ref.file).toEqual([
        resourceType,
      ]);
    }
  });

  it("every handler action is granted by exactly one apparatus policy, and no policy grants an unused action", () => {
    const granted = [...APPARATUS_MEMBER_ACTIONS, ...APPARATUS_OFFICER_ACTIONS] as string[];
    expect(new Set(granted).size).toBe(granted.length);
    expect(refs.map((r) => r.actionId).sort()).toEqual([...granted].sort());
  });

  it.each(APPARATUS_MEMBER_ACTIONS.flatMap((action) => ROLE_GROUPS.map((g) => [action, g])))(
    "ALLOWs every-role action %s for %s",
    async (action, group) => {
      expect(await decide(group, action, resourceFor(action))).toBe("allow");
    },
  );

  it.each(
    APPARATUS_OFFICER_ACTIONS.flatMap((action) =>
      ["APPARATUS", "OFFICER", "CHIEF", "ADMIN"].map((g) => [action, g]),
    ),
  )("ALLOWs apparatus-officer action %s for %s", async (action, group) => {
    expect(await decide(group, action, resourceFor(action))).toBe("allow");
  });

  it.each(
    APPARATUS_OFFICER_ACTIONS.flatMap((action) => ["MEMBER", "TRAINING"].map((g) => [action, g])),
  )("DENYs apparatus-officer action %s for %s", async (action, group) => {
    expect(await decide(group, action, resourceFor(action))).toBe("deny");
  });

  it("DENYs a caller whose group id is the bare name, not pool-qualified", async () => {
    const { isAuthorized } =
      (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
    const resource = { type: "Boxalarm::Apparatus", id: "ENGINE-2" };
    const result = isAuthorized({
      principal: { type: "Boxalarm::User", id: "u" },
      action: { type: "Boxalarm::Action", id: "SubmitApparatusCheck" },
      resource,
      context: {},
      schema: JSON.parse(CEDAR_SCHEMA) as string,
      policies: { staticPolicies: apparatusMemberActionsPolicy("pool-1") },
      entities: [
        {
          uid: { type: "Boxalarm::User", id: "u" },
          attrs: {},
          parents: [{ type: "Boxalarm::UserGroup", id: "MEMBER" }],
        },
        { uid: { type: "Boxalarm::UserGroup", id: "MEMBER" }, attrs: {}, parents: [] },
        { uid: resource, attrs: {}, parents: [] },
      ],
    });
    expect(result.type === "success" && result.response.decision).toBe("deny");
  });

  it("DENYs the pre-fix unqualified 'Apparatus' action type (implicit DENY, not an error-free allow)", async () => {
    const { isAuthorized } =
      (await import("@cedar-policy/cedar-wasm/nodejs")) as typeof import("@cedar-policy/cedar-wasm/nodejs");
    const result = isAuthorized({
      principal: { type: "Boxalarm::User", id: "u" },
      action: { type: "Apparatus", id: "UpdateServiceStatus" },
      resource: { type: "Apparatus", id: "ENGINE-2" },
      context: {},
      policies: { staticPolicies: apparatusOfficerActionsPolicy("pool-1") },
      entities: [
        {
          uid: { type: "Boxalarm::User", id: "u" },
          attrs: {},
          parents: [{ type: "Boxalarm::UserGroup", id: "pool-1|CHIEF" }],
        },
        { uid: { type: "Boxalarm::UserGroup", id: "pool-1|CHIEF" }, attrs: {}, parents: [] },
      ],
    });
    expect(result.type).toBe("success");
    expect(result.type === "success" && result.response.decision).toBe("deny");
  });
});

describe("PolicyStore apparatus policies", () => {
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

  async function statement(
    policy: pulumi.Output<{ static?: { statement: string } } | undefined>,
  ): Promise<string> {
    const def = await new Promise<{ static?: { statement: string } } | undefined>((res) =>
      policy.apply(res),
    );
    return def?.static?.statement ?? "";
  }

  it("deploys both apparatus policies with pool-qualified groups and no permit-all", async () => {
    const { PolicyStore } = await import("../../components/authz/policy-store");
    const store = new PolicyStore("apparatus-policy-store", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      userPoolArn: pulumi.output("arn:aws:cognito-idp:us-east-1:123456789012:userpool/pool-1"),
      allowedClientIds: [pulumi.output("web-client")],
    });
    const member = await statement(store.apparatusMemberActionsPolicy.definition);
    const officer = await statement(store.apparatusOfficerActionsPolicy.definition);

    expect(member).toContain('Action::"SubmitApparatusCheck"');
    expect(member).toContain('UserGroup::"pool-1|MEMBER"');
    expect(officer).toContain('Action::"UpdateServiceStatus"');
    expect(officer).toContain('UserGroup::"pool-1|APPARATUS"');
    expect(officer).not.toContain('"pool-1|MEMBER"');
    for (const text of [member, officer]) {
      expect(text).not.toContain('UserGroup::"MEMBER"');
      expect(text).not.toMatch(/permit\s*\(\s*principal\s*,\s*action\s*,\s*resource\s*\)\s*;/);
    }
  });
});
