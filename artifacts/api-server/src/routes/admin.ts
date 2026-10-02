import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  GetAdminDashboardResponse,
  GetDemandSignalsResponse,
  ListAdminAlertsResponse,
  ListInventoryRiskQueryParams,
  ListInventoryRiskResponse,
  ResetDemoResponse,
  SimulateImpactBody,
  SimulateImpactResponse,
  UpdateAdminAlertBody,
  UpdateAdminAlertParams,
  UpdateAdminAlertResponse,
} from "@workspace/api-zod";
import {
  alertsTable,
  db,
  demoStateTable,
  inventoryTable,
  ordersTable,
  searchEventsTable,
  storesTable,
} from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import {
  availabilityConfidence,
  inventoryRisk,
  loadInventoryRows,
} from "../lib/inventory";
import { resetDemoData } from "../lib/seed";

const router: IRouter = Router();

const officialBaseline = {
  registeredUsers: 120_000,
  monthlyActiveUsers: 46_000,
  monthlyOrders: 38_500,
  averageOrderValue: 486,
  monthlyRevenueLakh: 26.1,
  repeatPurchaseRate: 27,
  cancellationRate: 11,
  averageDeliveryMinutes: 37,
  supportTickets: 5_900,
};

router.get(
  "/admin/dashboard",
  requireAuth,
  requireRole("ADMIN"),
  async (_req, res): Promise<void> => {
    const [inventoryRows, orders, openAlerts] = await Promise.all([
      loadInventoryRows(),
      db.select().from(ordersTable),
      db.select().from(alertsTable).where(eq(alertsTable.status, "OPEN")),
    ]);
    const highRiskProducts = inventoryRows.filter(
      (row) => availabilityConfidence(row) < 50,
    ).length;
    const atRiskOrders = orders.filter(
      (order) =>
        !["DELIVERED", "CANCELLED", "REFUNDED"].includes(order.status) &&
        order.riskScore >= 30,
    ).length;
    const storesRequiringAttention = new Set(openAlerts.map((alert) => alert.storeId))
      .size;
    res.json(
      GetAdminDashboardResponse.parse({
        ...officialBaseline,
        highRiskProducts,
        atRiskOrders,
        storesRequiringAttention,
        sixMonthTrend: [
          {
            month: "6 months ago",
            orders: 31_200,
            repeatRate: 41,
            cancellations: 6,
            revenueLakh: 21.8,
          },
          {
            month: "Current",
            orders: 38_500,
            repeatRate: 27,
            cancellations: 11,
            revenueLakh: 26.1,
          },
        ],
      }),
    );
  },
);

router.get(
  "/admin/inventory-risk",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const query = ListInventoryRiskQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Choose a valid inventory-risk filter." });
      return;
    }
    const rows = await loadInventoryRows();
    const searchEvents = await db.select().from(searchEventsTable);
    const searchCount = new Map<string, number>();
    for (const event of searchEvents) {
      if (event.productId) {
        searchCount.set(event.productId, (searchCount.get(event.productId) ?? 0) + 1);
      }
    }
    const items = rows
      .map((row) => {
        const confidence = availabilityConfidence(row);
        return {
          inventoryId: row.inventory.id,
          productId: row.product.id,
          productName: row.product.name,
          storeId: row.store.id,
          storeName: row.store.name,
          confidence,
          risk: inventoryRisk(confidence),
          lastUpdated: row.inventory.lastUpdated.toISOString(),
          recentFailures: row.inventory.recentFailures,
          frequentSearches: searchCount.get(row.product.id) ?? 0,
        };
      })
      .filter((item) => {
        const filter = query.data.filter ?? "all";
        if (filter === "high") return item.confidence < 50;
        if (filter === "uncertain") {
          return item.confidence >= 50 && item.confidence < 75;
        }
        if (filter === "recently-failed") return item.recentFailures > 0;
        if (filter === "low-confidence") return item.confidence < 75;
        return true;
      })
      .sort((a, b) => a.confidence - b.confidence);
    res.json(ListInventoryRiskResponse.parse(items));
  },
);

router.get(
  "/admin/alerts",
  requireAuth,
  requireRole("ADMIN"),
  async (_req, res): Promise<void> => {
    const rows = await db
      .select({ alert: alertsTable, storeName: storesTable.name })
      .from(alertsTable)
      .innerJoin(storesTable, eq(alertsTable.storeId, storesTable.id))
      .orderBy(desc(alertsTable.createdAt));
    const alerts = rows.map(({ alert, storeName }) => ({
      id: alert.id,
      severity: alert.severity,
      type: alert.type,
      storeId: alert.storeId,
      storeName,
      productName: alert.productName,
      reason: alert.reason,
      recommendedAction: alert.recommendedAction,
      status: alert.status,
      createdAt: alert.createdAt.toISOString(),
    }));
    res.json(ListAdminAlertsResponse.parse(alerts));
  },
);

router.patch(
  "/admin/alerts/:alertId",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const params = UpdateAdminAlertParams.safeParse(req.params);
    const body = UpdateAdminAlertBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Choose a valid alert action." });
      return;
    }
    const [updated] = await db
      .update(alertsTable)
      .set({ status: body.data.status, updatedAt: new Date() })
      .where(eq(alertsTable.id, params.data.alertId))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Operational alert not found." });
      return;
    }
    const [store] = await db
      .select({ name: storesTable.name })
      .from(storesTable)
      .where(eq(storesTable.id, updated.storeId));
    res.json(
      UpdateAdminAlertResponse.parse({
        id: updated.id,
        severity: updated.severity,
        type: updated.type,
        storeId: updated.storeId,
        storeName: store?.name ?? "Unknown store",
        productName: updated.productName,
        reason: updated.reason,
        recommendedAction: updated.recommendedAction,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
      }),
    );
  },
);

router.get(
  "/admin/demand",
  requireAuth,
  requireRole("ADMIN"),
  async (_req, res): Promise<void> => {
    const events = await db.select().from(searchEventsTable);
    const inventoryRows = await loadInventoryRows();
    const grouped = new Map<
      string,
      { total: number; available: number; productId: string | null }
    >();
    for (const event of events) {
      const key = event.searchTerm.trim().toLowerCase();
      const value = grouped.get(key) ?? {
        total: 0,
        available: 0,
        productId: event.productId,
      };
      value.total += 1;
      if (event.available) value.available += 1;
      if (!value.productId && event.productId) value.productId = event.productId;
      grouped.set(key, value);
    }
    const signals = [...grouped.entries()]
      .map(([searchTerm, value]) => {
        const product = value.productId
          ? inventoryRows.find((row) => row.product.id === value.productId)?.product
          : undefined;
        const matchingInventories = value.productId
          ? inventoryRows.filter((row) => row.product.id === value.productId)
          : [];
        const availabilityRate = value.total
          ? Math.round((value.available / value.total) * 100)
          : 0;
        return {
          productName: product?.name ?? searchTerm,
          category: product?.category ?? "Search demand",
          searchesPerWeek: value.total,
          availabilityRate,
          storeCoverage: new Set(matchingInventories.map((row) => row.store.id)).size,
          opportunity:
            availabilityRate < 60
              ? "Frequent searches meet a weak availability signal; review stock freshness and nearby coverage."
              : "Search demand is being met more consistently; keep partner inventory current.",
        };
      })
      .sort((a, b) => b.searchesPerWeek - a.searchesPerWeek);
    res.json(GetDemandSignalsResponse.parse(signals));
  },
);

router.post(
  "/admin/impact",
  requireAuth,
  requireRole("ADMIN"),
  async (req, res): Promise<void> => {
    const body = SimulateImpactBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Use values within the supported scenario ranges." });
      return;
    }
    const {
      availabilityImprovement,
      cancellationReduction,
      repeatRateImprovement,
      supportTicketReduction,
    } = body.data;
    const availabilityLinkedReduction = availabilityImprovement * 0.35;
    const totalReduction = Math.min(
      officialBaseline.cancellationRate,
      cancellationReduction + availabilityLinkedReduction,
    );
    const monthlyOrdersProtected = Math.round(
      officialBaseline.monthlyOrders * (totalReduction / 100),
    );
    const supportTicketsAvoided = Math.round(
      officialBaseline.supportTickets * (supportTicketReduction / 100),
    );
    const incrementalRevenueLakh = Number(
      (
        (officialBaseline.monthlyRevenueLakh *
          monthlyOrdersProtected) /
        officialBaseline.monthlyOrders
      ).toFixed(2),
    );
    res.json(
      SimulateImpactResponse.parse({
        label: "Illustrative projection",
        cancellationRate: Number(
          (officialBaseline.cancellationRate - totalReduction).toFixed(1),
        ),
        repeatPurchaseRate: Math.min(
          100,
          officialBaseline.repeatPurchaseRate + repeatRateImprovement,
        ),
        monthlyOrdersProtected,
        supportTicketsAvoided,
        incrementalRevenueLakh,
        implementationBudgetLakh: 25,
        methodology: [
          "Baseline values are the official NOVA CART challenge figures, not live operating results.",
          `Availability scenario uses the case's 35% unavailable-product cancellation share; ${availabilityImprovement} points of availability improvement is treated as a potential cancellation contribution.`,
          `The cancellation scenario adds ${cancellationReduction} percentage points of reduction; combined reductions are capped at the official 11% cancellation baseline.`,
          "Potential platform revenue is scaled from reported monthly revenue per monthly order; it is not gross merchandise value or an achieved result.",
          `Support-ticket avoidance and repeat-rate change are scenario inputs (${supportTicketReduction}% and ${repeatRateImprovement} points), not measured outcomes.`,
        ],
      }),
    );
  },
);

router.post(
  "/demo/reset",
  requireAuth,
  requireRole("ADMIN", "STORE", "CUSTOMER"),
  async (_req, res): Promise<void> => {
    await resetDemoData(true);
    const [state] = await db
      .select({ resetCount: demoStateTable.resetCount })
      .from(demoStateTable)
      .where(eq(demoStateTable.id, "nova-pulse"));
    res.json(
      ResetDemoResponse.parse({
        message: `Demo data restored to baseline. Reset ${state?.resetCount ?? 1}.`,
      }),
    );
  },
);

export default router;