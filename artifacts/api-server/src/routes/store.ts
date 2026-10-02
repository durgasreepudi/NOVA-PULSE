import { randomUUID } from "node:crypto";
import { and, eq, gte, ne } from "drizzle-orm";
import { count } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  GetStoreDashboardResponse,
  ListStoreAlertsResponse,
  ListStoreInventoryResponse,
  ListStoreOrdersResponse,
  UpdateStoreInventoryBody,
  UpdateStoreInventoryParams,
  UpdateStoreInventoryResponse,
  UpdateStoreOrderStatusBody,
  UpdateStoreOrderStatusParams,
  UpdateStoreOrderStatusResponse,
} from "@workspace/api-zod";
import {
  alertsTable,
  availabilitySignalsTable,
  db,
  inventoryEventsTable,
  inventoryTable,
  ordersTable,
  orderStatusHistoryTable,
} from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import {
  availabilityConfidence,
  confidenceLabel,
  getInventoryById,
  inventoryForStore,
  inventoryRisk,
  toInventoryItem,
} from "../lib/inventory";
import { listOrdersForUser } from "../lib/orders";

const router: IRouter = Router();
const nextStatus: Record<string, string> = {
  PLACED: "STORE_CONFIRMED",
  STORE_CONFIRMED: "PREPARING",
  PREPARING: "READY",
  READY: "OUT_FOR_DELIVERY",
  OUT_FOR_DELIVERY: "DELIVERED",
};

router.get(
  "/store/dashboard",
  requireAuth,
  requireRole("STORE"),
  async (req, res): Promise<void> => {
    const storeId = req.authUser!.storeId;
    if (!storeId) {
      res.status(403).json({ error: "This account is not linked to a store." });
      return;
    }
    const [inventory, orders] = await Promise.all([
      inventoryForStore(storeId),
      listOrdersForUser(req.authUser!),
    ]);
    const confidenceScores = inventory.map((row) => availabilityConfidence(row));
    const lowConfidenceCount = confidenceScores.filter((score) => score < 75).length;
    const pendingOrders = orders.filter(
      (order) => !["DELIVERED", "CANCELLED", "REFUNDED"].includes(order.status),
    ).length;
    const averageConfidence = confidenceScores.length
      ? Math.round(
          confidenceScores.reduce((sum, score) => sum + score, 0) /
            confidenceScores.length,
        )
      : 100;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [todaysOrders] = await db
      .select({ total: count() })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.storeId, storeId),
          gte(ordersTable.createdAt, startOfDay),
        ),
      );
    const storeName = req.authUser!.storeName ?? "Your store";
    res.json(
      GetStoreDashboardResponse.parse({
        storeName,
        todaysOrders: todaysOrders?.total ?? 0,
        pendingOrders,
        lowConfidenceCount,
        updatesNeeded: lowConfidenceCount,
        operationalScore: averageConfidence,
      }),
    );
  },
);

router.get(
  "/store/inventory",
  requireAuth,
  requireRole("STORE"),
  async (req, res): Promise<void> => {
    const storeId = req.authUser!.storeId;
    if (!storeId) {
      res.status(403).json({ error: "This account is not linked to a store." });
      return;
    }
    const rows = await inventoryForStore(storeId);
    res.json(ListStoreInventoryResponse.parse(rows.map(toInventoryItem)));
  },
);

router.patch(
  "/store/inventory/:inventoryId",
  requireAuth,
  requireRole("STORE"),
  async (req, res): Promise<void> => {
    const params = UpdateStoreInventoryParams.safeParse(req.params);
    const body = UpdateStoreInventoryBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Enter a valid stock count." });
      return;
    }
    const current = await getInventoryById(params.data.inventoryId);
    if (!current || current.store.id !== req.authUser!.storeId) {
      res.status(404).json({ error: "Inventory item not found for this store." });
      return;
    }
    const isAvailable = body.data.available && body.data.stock > 0;
    const updatedAt = new Date();
    const [updated] = await db
      .update(inventoryTable)
      .set({
        stock: isAvailable ? body.data.stock : 0,
        available: isAvailable,
        lastUpdated: updatedAt,
        updatedAt,
      })
      .where(eq(inventoryTable.id, params.data.inventoryId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Inventory item not found." });
      return;
    }

    await db.insert(inventoryEventsTable).values({
      id: randomUUID(),
      inventoryId: updated.id,
      userId: req.authUser!.id,
      eventType: isAvailable ? "STOCK_UPDATED" : "MARKED_UNAVAILABLE",
      previousStock: current.inventory.stock,
      newStock: updated.stock,
      note: isAvailable
        ? `Store partner confirmed ${updated.stock} units.`
        : "Store partner marked this item unavailable.",
    });
    const refreshed = await getInventoryById(updated.id);
    if (!refreshed) {
      res.status(500).json({ error: "The update saved but the item could not be reloaded." });
      return;
    }
    const confidence = availabilityConfidence(refreshed);
    await db.insert(availabilitySignalsTable).values({
      id: randomUUID(),
      inventoryId: updated.id,
      signalType: "STORE_UPDATE",
      score: confidence,
      details: `Stock and freshness were recalculated from the store update at ${updatedAt.toISOString()}.`,
    });

    const activeAlerts = await db
      .select()
      .from(alertsTable)
      .where(
        and(
          eq(alertsTable.inventoryId, updated.id),
          ne(alertsTable.status, "RESOLVED"),
        ),
      );
    if (confidence < 75 && !activeAlerts.length) {
      await db.insert(alertsTable).values({
        id: randomUUID(),
        severity: confidence < 50 ? "HIGH" : "MEDIUM",
        type: "LOW_CONFIDENCE",
        storeId: current.store.id,
        inventoryId: updated.id,
        productName: current.product.name,
        reason: "Availability confidence remains below the operating threshold.",
        recommendedAction: "Confirm the shelf count again after the next restock.",
        status: "OPEN",
      });
    } else if (confidence >= 75 && activeAlerts.length) {
      await db
        .update(alertsTable)
        .set({ status: "RESOLVED", updatedAt: new Date() })
        .where(
          and(
            eq(alertsTable.inventoryId, updated.id),
            ne(alertsTable.status, "RESOLVED"),
          ),
        );
    }

    res.json(
      UpdateStoreInventoryResponse.parse(toInventoryItem(refreshed)),
    );
  },
);

router.get(
  "/store/alerts",
  requireAuth,
  requireRole("STORE"),
  async (req, res): Promise<void> => {
    const storeId = req.authUser!.storeId;
    if (!storeId) {
      res.status(403).json({ error: "This account is not linked to a store." });
      return;
    }
    const rows = await db
      .select()
      .from(alertsTable)
      .where(
        and(
          eq(alertsTable.storeId, storeId),
          ne(alertsTable.status, "RESOLVED"),
        ),
      );
    const alerts = rows.map((row) => ({
      id: row.id,
      severity: row.severity,
      type: row.type,
      storeId: row.storeId,
      storeName: req.authUser!.storeName ?? "Your store",
      productName: row.productName,
      reason: row.reason,
      recommendedAction: row.recommendedAction,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
    res.json(ListStoreAlertsResponse.parse(alerts));
  },
);

router.get(
  "/store/orders",
  requireAuth,
  requireRole("STORE"),
  async (req, res): Promise<void> => {
    const orders = await listOrdersForUser(req.authUser!);
    res.json(ListStoreOrdersResponse.parse(orders));
  },
);

router.patch(
  "/store/orders/:orderId",
  requireAuth,
  requireRole("STORE"),
  async (req, res): Promise<void> => {
    const params = UpdateStoreOrderStatusParams.safeParse(req.params);
    const body = UpdateStoreOrderStatusBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Choose a valid order status." });
      return;
    }
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.id, params.data.orderId),
          eq(ordersTable.storeId, req.authUser!.storeId ?? ""),
        ),
      );
    if (!order) {
      res.status(404).json({ error: "Order not found for this store." });
      return;
    }
    if (nextStatus[order.status] !== body.data.status) {
      res.status(409).json({
        error: "Orders must move through each fulfillment step in order.",
      });
      return;
    }
    const [updated] = await db
      .update(ordersTable)
      .set({ status: body.data.status })
      .where(eq(ordersTable.id, order.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Order not found." });
      return;
    }
    await db.insert(orderStatusHistoryTable).values({
      id: randomUUID(),
      orderId: order.id,
      status: body.data.status,
      note: `${req.authUser!.storeName ?? "The store"} moved this order to ${body.data.status.replaceAll("_", " ").toLowerCase()}.`,
    });
    const orders = await listOrdersForUser(req.authUser!);
    const response = orders.find((item) => item.id === order.id);
    if (!response) {
      res.status(500).json({ error: "The order changed but could not be reloaded." });
      return;
    }
    res.json(UpdateStoreOrderStatusResponse.parse(response));
  },
);

export default router;