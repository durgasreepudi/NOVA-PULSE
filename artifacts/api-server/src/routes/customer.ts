import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CheckOrderRiskBody,
  CheckOrderRiskResponse,
  CreateOrderBody,
  CreateOrderResponse,
  GetOrderParams,
  GetOrderResponse,
  GetProductAlternativesParams,
  GetProductAlternativesResponse,
  GetProductParams,
  GetProductResponse,
  ListOrdersResponse,
  ListProductsQueryParams,
  ListProductsResponse,
} from "@workspace/api-zod";
import {
  alertsTable,
  db,
  inventoryEventsTable,
  inventoryTable,
  orderItemsTable,
  orderStatusHistoryTable,
  ordersTable,
  productsTable,
  searchEventsTable,
  storesTable,
} from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import {
  availabilityConfidence,
  confidenceLabel,
  findAlternatives,
  getInventoryForProduct,
  inventoryRisk,
  loadInventoryRows,
  toProduct,
} from "../lib/inventory";
import { getOrderForUser, listOrdersForUser } from "../lib/orders";

const router: IRouter = Router();

function calculateRisk(
  productRows: Array<{ productId: string; productName: string; confidence: number }>,
) {
  if (!productRows.length) {
    return { level: "LOW" as const, score: 0, reasons: [], alternatives: [] };
  }
  const score = Math.round(
    productRows.reduce((sum, item) => sum + (100 - item.confidence), 0) /
      productRows.length,
  );
  const level = score >= 50 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW";
  const reasons = productRows
    .filter((item) => item.confidence < 75)
    .map(
      (item) =>
        `${item.productName} has ${item.confidence}% availability confidence.`,
    );
  return { level, score, reasons, alternatives: [] as Array<{
    productId: string;
    productName: string;
    confidence: number;
    price: number;
  }> };
}

router.get(
  "/products",
  requireAuth,
  requireRole("CUSTOMER"),
  async (req, res): Promise<void> => {
    const query = ListProductsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "The product search filters were not valid." });
      return;
    }
    const rows = await loadInventoryRows();
    const search = query.data.search?.trim().toLocaleLowerCase();
    const category = query.data.category?.trim().toLocaleLowerCase();
    const products = rows
      .filter((row) => row.inventory.available || row.inventory.stock > 0)
      .filter(
        (row) =>
          !search ||
          `${row.product.name} ${row.product.category} ${row.store.name}`
            .toLocaleLowerCase()
            .includes(search),
      )
      .filter(
        (row) =>
          !category ||
          row.product.category.toLocaleLowerCase() === category,
      )
      .map(toProduct)
      .sort(
        (a, b) =>
          b.confidence - a.confidence || a.storeDistanceKm - b.storeDistanceKm,
      );

    if (search && search.length >= 3) {
      const match = products[0];
      await db.insert(searchEventsTable).values({
        id: randomUUID(),
        customerId: req.authUser!.id,
        productId: match?.id ?? null,
        searchTerm: search,
        available: Boolean(match && match.confidence >= 75),
      });
    }
    res.json(ListProductsResponse.parse(products));
  },
);

router.get(
  "/products/:productId",
  requireAuth,
  requireRole("CUSTOMER"),
  async (req, res): Promise<void> => {
    const params = GetProductParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "The product identifier was not valid." });
      return;
    }
    const rows = await loadInventoryRows();
    const row = rows.find((candidate) => candidate.product.id === params.data.productId);
    if (!row) {
      res.status(404).json({ error: "That product is not available in the demo catalogue." });
      return;
    }
    res.json(GetProductResponse.parse(toProduct(row)));
  },
);

router.get(
  "/products/:productId/alternatives",
  requireAuth,
  requireRole("CUSTOMER"),
  async (req, res): Promise<void> => {
    const params = GetProductAlternativesParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "The product identifier was not valid." });
      return;
    }
    const alternatives = await findAlternatives(params.data.productId);
    res.json(GetProductAlternativesResponse.parse(alternatives));
  },
);

router.post(
  "/orders/check-risk",
  requireAuth,
  requireRole("CUSTOMER"),
  async (req, res): Promise<void> => {
    const body = CheckOrderRiskBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Review the items in your basket and try again." });
      return;
    }
    const rows = await loadInventoryRows();
    const items = body.data.items.map((item) => {
      const row = rows.find((candidate) => candidate.product.id === item.productId);
      return row
        ? {
            productId: row.product.id,
            productName: row.product.name,
            confidence: availabilityConfidence(row),
          }
        : {
            productId: item.productId,
            productName: "Unknown product",
            confidence: 0,
          };
    });
    const risk = calculateRisk(items);
    const alternatives: Array<{
      productId: string;
      productName: string;
      confidence: number;
      price: number;
    }> = [];
    for (const item of items.filter((candidate) => candidate.confidence < 75)) {
      const suggestions = await findAlternatives(item.productId);
      const best = suggestions[0];
      if (best) {
        alternatives.push({
          productId: best.id,
          productName: best.name,
          confidence: best.confidence,
          price: best.price,
        });
      }
    }
    res.json(
      CheckOrderRiskResponse.parse({
        ...risk,
        alternatives,
      }),
    );
  },
);

router.get(
  "/orders",
  requireAuth,
  requireRole("CUSTOMER", "STORE", "ADMIN"),
  async (req, res): Promise<void> => {
    const orders = await listOrdersForUser(req.authUser!);
    res.json(ListOrdersResponse.parse(orders));
  },
);

router.get(
  "/orders/:orderId",
  requireAuth,
  requireRole("CUSTOMER", "STORE", "ADMIN"),
  async (req, res): Promise<void> => {
    const params = GetOrderParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "The order identifier was not valid." });
      return;
    }
    const order = await getOrderForUser(params.data.orderId, req.authUser!);
    if (!order) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    res.json(GetOrderResponse.parse(order));
  },
);

router.post(
  "/orders",
  requireAuth,
  requireRole("CUSTOMER"),
  async (req, res): Promise<void> => {
    const body = CreateOrderBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Add a delivery address and valid basket items." });
      return;
    }
    const allRows = await loadInventoryRows();
    const selected = body.data.items.map((line) => {
      const candidates = allRows.filter(
        (row) =>
          row.product.id === line.productId &&
          row.inventory.available &&
          row.inventory.stock >= line.quantity,
      );
      candidates.sort(
        (a, b) =>
          availabilityConfidence(b) - availabilityConfidence(a) ||
          a.store.distanceKm - b.store.distanceKm,
      );
      return { line, row: candidates[0] };
    });
    if (selected.some((item) => !item.row)) {
      res.status(409).json({
        error: "One or more items changed while you were checking out. Review your basket again.",
      });
      return;
    }

    const grouped = new Map<
      string,
      {
        storeId: string;
        storeName: string;
        lines: Array<{
          productId: string;
          productName: string;
          quantity: number;
          price: number;
          inventoryId: string;
          stock: number;
          confidence: number;
        }>;
      }
    >();
    for (const item of selected) {
      const row = item.row!;
      const group = grouped.get(row.store.id) ?? {
        storeId: row.store.id,
        storeName: row.store.name,
        lines: [],
      };
      group.lines.push({
        productId: row.product.id,
        productName: row.product.name,
        quantity: item.line.quantity,
        price: row.product.price,
        inventoryId: row.inventory.id,
        stock: row.inventory.stock,
        confidence: availabilityConfidence(row),
      });
      grouped.set(row.store.id, group);
    }

    const risk = calculateRisk(
      selected.map(({ row }) => ({
        productId: row!.product.id,
        productName: row!.product.name,
        confidence: availabilityConfidence(row!),
      })),
    );
    const createdIds = await db.transaction(async (tx) => {
      const ids: string[] = [];
      for (const group of grouped.values()) {
        const orderId = `order-${randomUUID().slice(0, 12)}`;
        const total = group.lines.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0,
        );
        await tx.insert(ordersTable).values({
          id: orderId,
          customerId: req.authUser!.id,
          storeId: group.storeId,
          status: "PLACED",
          total,
          address: body.data.address.trim(),
          paymentMethod: body.data.paymentMethod,
          riskScore: risk.score,
        });
        await tx.insert(orderItemsTable).values(
          group.lines.map((item) => ({
            id: randomUUID(),
            orderId,
            productId: item.productId,
            quantity: item.quantity,
            price: item.price,
            confidenceAtOrder: item.confidence,
            storeName: group.storeName,
          })),
        );
        await tx.insert(orderStatusHistoryTable).values({
          id: randomUUID(),
          orderId,
          status: "PLACED",
          note:
            risk.score >= 50
              ? "Order placed after an availability risk review."
              : "Order placed with current availability signals.",
        });
        for (const item of group.lines) {
          const newStock = item.stock - item.quantity;
          await tx
            .update(inventoryTable)
            .set({
              stock: newStock,
              available: newStock > 0,
              lastUpdated: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(inventoryTable.id, item.inventoryId));
          await tx.insert(inventoryEventsTable).values({
            id: randomUUID(),
            inventoryId: item.inventoryId,
            userId: req.authUser!.id,
            eventType: "ORDER_RESERVED",
            previousStock: item.stock,
            newStock,
            note: `Reserved ${item.quantity} for ${orderId}.`,
          });
          if (newStock === 0) {
            await tx.insert(alertsTable).values({
              id: randomUUID(),
              severity: "HIGH",
              type: "STOCK_DEPLETED",
              storeId: group.storeId,
              inventoryId: item.inventoryId,
              productName: item.productName,
              reason: "The last available units were reserved by an order.",
              recommendedAction: "Refresh stock before accepting another order.",
              status: "OPEN",
            });
          }
        }
        ids.push(orderId);
      }
      return ids;
    });

    const order = createdIds[0]
      ? await getOrderForUser(createdIds[0], req.authUser!)
      : null;
    if (!order) {
      res.status(500).json({ error: "The order was saved but could not be loaded." });
      return;
    }
    res.status(201).json(CreateOrderResponse.parse(order));
  },
);

export default router;