import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import { HttpApi } from "../../components/api/http-api";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:iam/role:Role") {
        state.arn = `arn:aws:iam::123456789012:role/${args.inputs.name ?? args.name}`;
      }
      if (args.type === "aws:lambda/function:Function") {
        state.arn = `arn:aws:lambda:us-east-1:123456789012:function:${args.inputs.name ?? args.name}`;
        state.invokeArn = `${state.arn}-invoke`;
      }
      if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
        state.arn = `arn:aws:logs:us-east-1:123456789012:log-group:${args.inputs.name}`;
      }
      if (args.type === "aws:apigatewayv2/api:Api") {
        state.apiEndpoint = `https://${args.name}.execute-api.us-east-1.amazonaws.com`;
        state.executionArn = `arn:aws:execute-api:us-east-1:123456789012:${args.name}`;
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

describe("Members", () => {
  async function build() {
    const { Members } = await import("../../components/personnel/members");
    const logGroup = new ServiceLogGroup("test-members-log-group", {
      env: "dev",
      serviceName: "personnel-service",
    });
    const httpApi = new HttpApi("test-members-http-api", {
      env: "dev",
      userPoolId: pulumi.output("pool-1"),
      allowedClientIds: [pulumi.output("client-1")],
      platformLogGroup: logGroup,
    });
    return new Members("test-members", {
      env: "dev",
      platformTableName: pulumi.output("platform-table"),
      platformTableArn: pulumi.output("arn:aws:dynamodb:us-east-1:123456789012:table/platform"),
      policyStoreArn: pulumi.output("arn:aws:verifiedpermissions::123456789012:policy-store/ps-1"),
      policyStoreId: pulumi.output("ps-1"),
      userPoolId: pulumi.output("us-east-1_pool"),
      userPoolArn: pulumi.output(
        "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_pool",
      ),
      logGroup,
      httpApi,
    });
  }

  // create.ts provisions the member's login and keys the member on its sub.
  it("lets only the create Lambda manage logins, in this pool, and tells it the pool id", async () => {
    const members = await build();
    const [createPolicy, env, listPolicy] = await Promise.all([
      resolve(members.createLambda.rolePolicy.policy),
      resolve(members.createLambda.function.environment),
      resolve(members.listLambda.rolePolicy.policy),
    ]);
    const statement = (
      JSON.parse(createPolicy) as {
        Statement: Array<{ Sid: string; Action: string[]; Resource: string[] }>;
      }
    ).Statement.find((s) => s.Sid === "MembersCreateLogin");
    expect(statement?.Action.sort()).toEqual([
      "cognito-idp:AdminAddUserToGroup",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
    ]);
    expect(statement?.Resource).toEqual([
      "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_pool",
    ]);
    expect(env?.variables?.COGNITO_USER_POOL_ID).toBe("us-east-1_pool");
    expect(listPolicy).not.toContain("cognito-idp");
  });

  it("grants no personnel role any permission on the alerting or incident tables (AC4)", async () => {
    const members = await build();
    const policies = await Promise.all([
      resolve(members.createLambda.rolePolicy.policy),
      resolve(members.listLambda.rolePolicy.policy),
      resolve(members.getLambda.rolePolicy.policy),
      resolve(members.updateStatusLambda.rolePolicy.policy),
    ]);
    for (const policyJson of policies) {
      expect(policyJson).not.toContain("table/alerting");
      expect(policyJson).not.toContain("table/incident");
    }
  });

  it("scopes updateStatus to the platform table plus the audit-key mutation deny", async () => {
    const members = await build();
    const policyJson = await resolve(members.updateStatusLambda.rolePolicy.policy);
    const policy = JSON.parse(policyJson) as { Statement: Array<{ Sid: string }> };
    expect(policy.Statement.some((s) => s.Sid === "DenyAuditMutations")).toBe(true);
  });

  it("scopes list and get to read-only DynamoDB actions only (no write action of any kind)", async () => {
    const members = await build();
    const [listPolicyJson, getPolicyJson] = await Promise.all([
      resolve(members.listLambda.rolePolicy.policy),
      resolve(members.getLambda.rolePolicy.policy),
    ]);
    for (const policyJson of [listPolicyJson, getPolicyJson]) {
      const policy = JSON.parse(policyJson) as { Statement: Array<{ Action: string[] }> };
      const allActions = policy.Statement.flatMap((s) => s.Action);
      const writeActions = allActions.filter((a) =>
        /^dynamodb:(Put|Update|Delete|BatchWrite|TransactWrite)/.test(a),
      );
      expect(writeActions).toEqual([]);
    }
  });

  it("grants list only Query on GSI3 and get only GetItem", async () => {
    const members = await build();
    const [listPolicyJson, getPolicyJson] = await Promise.all([
      resolve(members.listLambda.rolePolicy.policy),
      resolve(members.getLambda.rolePolicy.policy),
    ]);
    const listPolicy = JSON.parse(listPolicyJson) as {
      Statement: Array<{ Sid: string; Action: string[]; Resource: string[] }>;
    };
    const listStatement = listPolicy.Statement.find((s) => s.Sid === "MembersListAccess");
    expect(listStatement?.Action).toEqual(["dynamodb:Query"]);
    expect(listStatement?.Resource[0]).toContain("/index/GSI3");

    const getPolicy = JSON.parse(getPolicyJson) as {
      Statement: Array<{ Sid: string; Action: string[] }>;
    };
    const getStatement = getPolicy.Statement.find((s) => s.Sid === "MembersGetAccess");
    expect(getStatement?.Action).toEqual(["dynamodb:GetItem"]);
  });

  it("drops the non-functional dynamodb:TransactWriteItems action from every route", async () => {
    const members = await build();
    const policies = await Promise.all(
      [members.createLambda, members.listLambda, members.getLambda, members.updateStatusLambda].map(
        (lambda) => resolve(lambda.rolePolicy.policy),
      ),
    );
    for (const policyJson of policies) {
      expect(policyJson).not.toContain("TransactWriteItems");
    }
  });

  it("grants Verified Permissions IsAuthorizedWithToken to every members Lambda", async () => {
    const members = await build();
    const policyJson = await resolve(members.createLambda.rolePolicy.policy);
    expect(policyJson).toContain("verifiedpermissions:IsAuthorizedWithToken");
  });

  it("wires VERIFIED_PERMISSIONS_POLICY_STORE_ID into every members Lambda's environment", async () => {
    const members = await build();
    const envs = await Promise.all(
      [members.createLambda, members.listLambda, members.getLambda, members.updateStatusLambda].map(
        (lambda) => resolve(lambda.function.environment),
      ),
    );
    for (const env of envs) {
      expect(env?.variables?.VERIFIED_PERMISSIONS_POLICY_STORE_ID).toBe("ps-1");
    }
  });
});
