import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { requireEnv } from "../shared/env";
import { ApparatusArgs, apparatusRoute } from "./apparatus-lambda";

/**
 * Compartment inventory (F4.8). Like maintenance, the {unitId} segment carries the
 * apparatusId (web InventoryTab passes unit.apparatusId) and compartmentItemRepository.ts
 * keys on it directly — no GSI lookup. Every route is Cedar-gated.
 */
export class Inventory extends pulumi.ComponentResource {
  public readonly listLambda: ServiceLambda;
  public readonly createLambda: ServiceLambda;
  public readonly quantityLambda: ServiceLambda;

  constructor(name: string, args: ApparatusArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ApparatusInventory", args.env);
    super("boxalarm:apparatus:Inventory", name, {}, opts);

    // listCompartmentItems: one consistent base-table Query.
    this.listLambda = apparatusRoute(this, name, args, {
      functionKey: "inventory-list",
      routeKey: "GET /api/v1/apparatus/{unitId}/inventory",
      cedar: true,
      grants: [{ sid: "InventoryListQuery", actions: ["dynamodb:Query"], on: ["table"] }],
    });

    // putCompartmentItem: a transaction of two Puts (item + audit row).
    this.createLambda = apparatusRoute(this, name, args, {
      functionKey: "inventory-create",
      routeKey: "POST /api/v1/apparatus/{unitId}/inventory",
      cedar: true,
      grants: [{ sid: "InventoryCreatePut", actions: ["dynamodb:PutItem"], on: ["table"] }],
    });

    // updateCompartmentItemQuantity: GetItem (old quantity for the audit row), then a
    // transaction of Update (item) + Put (audit row).
    this.quantityLambda = apparatusRoute(this, name, args, {
      functionKey: "inventory-quantity",
      routeKey: "PUT /api/v1/apparatus/{unitId}/inventory/{itemId}",
      cedar: true,
      grants: [
        {
          sid: "InventoryQuantityWrite",
          actions: ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"],
          on: ["table"],
        },
      ],
    });

    this.registerOutputs({
      listLambda: this.listLambda,
      createLambda: this.createLambda,
      quantityLambda: this.quantityLambda,
    });
  }
}
