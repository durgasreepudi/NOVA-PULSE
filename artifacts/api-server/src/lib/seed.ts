import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  alertsTable,
  availabilitySignalsTable,
  db,
  demoStateTable,
  inventoryEventsTable,
  inventoryTable,
  orderItemsTable,
  orderStatusHistoryTable,
  ordersTable,
  productsTable,
  recommendationsTable,
  rolesTable,
  searchEventsTable,
  storesTable,
  supportTicketsTable,
  usersTable,
} from "@workspace/db";
import { hashPassword } from "./auth";

const demoAccountPassword = "demo123";
const initialInventory = [
  {
    id: "inventory-milk",
    storeId: "store-market",
    productId: "milk",
    stock: 1,
    historicalAvailability: 15,
    recentFailures: 5,
    attemptedOrders: 20,
    fulfilledOrders: 3,
    ageHours: 14,
  },
  {
    id: "inventory-alt-milk",
    storeId: "store-dairy",
    productId: "alternative-milk",
    stock: 12,
    historicalAvailability: 60,
    recentFailures: 0,
    attemptedOrders: 20,
    fulfilledOrders: 16,
    ageHours: 0,
  },
  {
    id: "inventory-bread",
    storeId: "store-demo",
    productId: "bread",
    stock: 3,
    historicalAvailability: 95,
    recentFailures: 1,
    attemptedOrders: 40,
    fulfilledOrders: 38,
    ageHours: 48,
  },
  {
    id: "inventory-eggs",
    storeId: "store-demo",
    productId: "eggs",
    stock: 18,
    historicalAvailability: 94,
    recentFailures: 1,
    attemptedOrders: 45,
    fulfilledOrders: 42,
    ageHours: 2,
  },
  {
    id: "inventory-bananas",
    storeId: "store-demo",
    productId: "bananas",
    stock: 22,
    historicalAvailability: 92,
    recentFailures: 1,
    attemptedOrders: 36,
    fulfilledOrders: 33,
    ageHours: 3,
  },
  {
    id: "inventory-rice",
    storeId: "store-market",
    productId: "rice",
    stock: 8,
    historicalAvailability: 88,
    recentFailures: 2,
    attemptedOrders: 55,
    fulfilledOrders: 48,
    ageHours: 6,
  },
  {
    id: "inventory-tomatoes",
    storeId: "store-market",
    productId: "tomatoes",
    stock: 6,
    historicalAvailability: 72,
    recentFailures: 3,
    attemptedOrders: 26,
    fulfilledOrders: 19,
    ageHours: 20,
  },
  {
    id: "inventory-paneer",
    storeId: "store-dairy",
    productId: "paneer",
    stock: 7,
    historicalAvailability: 86,
    recentFailures: 2,
    attemptedOrders: 34,
    fulfilledOrders: 29,
    ageHours: 9,
  },
];

const productSeeds = [
  {
    id: "milk",
    name: "Fresh toned milk",
    category: "Dairy",
    description: "A daily essential from a nearby independent dairy partner.",
    price: 32,
    unit: "500 ml",
  },
  {
    id: "alternative-milk",
    name: "Alternative Milk",
    category: "Dairy",
    description: "A similar nearby dairy option with a fresher stock signal.",
    price: 34,
    unit: "500 ml",
  },
  {
    id: "bread",
    name: "Whole wheat bread",
    category: "Bakery",
    description: "Freshly baked local bread for everyday meals.",
    price: 48,
    unit: "loaf",
  },
  {
    id: "eggs",
    name: "Farm eggs",
    category: "Dairy & eggs",
    description: "A tray of locally supplied farm eggs.",
    price: 78,
    unit: "6 pack",
  },
  {
    id: "bananas",
    name: "Robusta bananas",
    category: "Fresh produce",
    description: "Sweet, ripe bananas selected by a neighborhood grocer.",
    price: 42,
    unit: "500 g",
  },
  {
    id: "rice",
    name: "Everyday sona masoori rice",
    category: "Pantry",
    description: "A pantry staple stocked by a local grocery partner.",
    price: 68,
    unit: "1 kg",
  },
  {
    id: "tomatoes",
    name: "Local tomatoes",
    category: "Fresh produce",
    description: "Seasonal tomatoes sourced from nearby suppliers.",
    price: 36,
    unit: "500 g",
  },
  {
    id: "paneer",
    name: "Fresh paneer",
    category: "Dairy",
    description: "Fresh paneer from a neighborhood dairy counter.",
    price: 92,
    unit: "200 g",
  },
];

const storeSeeds = [
  {
    id: "store-demo",
    name: "Green Basket Market",
    city: "Demo City A",
    distanceKm: 0.8,
    reliability: 90,
  },
  {
    id: "store-market",
    name: "Corner Pantry",
    city: "Demo City A",
    distanceKm: 1.2,
    reliability: 75,
  },
  {
    id: "store-dairy",
    name: "Daily Dairy & More",
    city: "Demo City B",
    distanceKm: 0.6,
    reliability: 80,
  },
];

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function seedCore(): Promise<void> {
  await db
    .insert(rolesTable)
    .values([
      { id: "CUSTOMER", name: "Customer" },
      { id: "STORE", name: "Store Partner" },
      { id: "ADMIN", name: "Operations Admin" },
    ])
    .onConflictDoNothing();

  await db.insert(storesTable).values(storeSeeds).onConflictDoNothing();
  await db
    .insert(usersTable)
    .values([
      {
        id: "demo-customer",
        email: "customer@nova.test",
        name: "Aarav Mehta",
        passwordHash: hashPassword(demoAccountPassword),
        roleId: "CUSTOMER",
        storeId: null,
      },
      {
        id: "demo-store-user",
        email: "store@nova.test",
        name: "Green Basket Market",
        passwordHash: hashPassword(demoAccountPassword),
        roleId: "STORE",
        storeId: "store-demo",
      },
      {
        id: "demo-admin",
        email: "admin@nova.test",
        name: "NOVA Operations",
        passwordHash: hashPassword(demoAccountPassword),
        roleId: "ADMIN",
        storeId: null,
      },
    ])
    .onConflictDoNothing();
  await db.insert(productsTable).values(productSeeds).onConflictDoNothing();

  const now = new Date();
  await db
    .insert(inventoryTable)
    .values(
      initialInventory.map((item) => ({
        id: item.id,
        storeId: item.storeId,
        productId: item.productId,
        stock: item.stock,
        available: item.stock > 0,
        historicalAvailability: item.historicalAvailability,
        recentFailures: item.recentFailures,
        attemptedOrders: item.attemptedOrders,
        fulfilledOrders: item.fulfilledOrders,
        lastUpdated: item.ageHours ? hoursAgo(item.ageHours) : now,
        updatedAt: item.ageHours ? hoursAgo(item.ageHours) : now,
      })),
    )
    .onConflictDoNothing();
  await db
    .insert(recommendationsTable)
    .values([
      {
        id: "recommend-milk-alt",
        productId: "milk",
        alternativeProductId: "alternative-milk",
        reason: "Similar dairy product with a fresher stock signal",
      },
      {
        id: "recommend-tomato-bananas",
        productId: "tomatoes",
        alternativeProductId: "bananas",
        reason: "Nearby fresh produce alternative",
      },
    ])
    .onConflictDoNothing();
}

export async function resetDemoData(incrementResetCount = true): Promise<void> {
  const [currentState] = await db
    .select()
    .from(demoStateTable)
    .where(eq(demoStateTable.id, "nova-pulse"));
  const nextResetCount = currentState
    ? currentState.resetCount + (incrementResetCount ? 1 : 0)
    : 0;

  await db.transaction(async (tx) => {
    await tx.delete(supportTicketsTable);
    await tx.delete(orderItemsTable);
    await tx.delete(orderStatusHistoryTable);
    await tx.delete(ordersTable);
    await tx.delete(alertsTable);
    await tx.delete(inventoryEventsTable);
    await tx.delete(availabilitySignalsTable);
    await tx.delete(searchEventsTable);

    for (const item of initialInventory) {
      const updatedAt = item.ageHours ? hoursAgo(item.ageHours) : new Date();
      await tx
        .update(inventoryTable)
        .set({
          stock: item.stock,
          available: item.stock > 0,
          historicalAvailability: item.historicalAvailability,
          recentFailures: item.recentFailures,
          attemptedOrders: item.attemptedOrders,
          fulfilledOrders: item.fulfilledOrders,
          lastUpdated: updatedAt,
          updatedAt,
        })
        .where(eq(inventoryTable.id, item.id));
      await tx.insert(inventoryEventsTable).values({
        id: randomUUID(),
        inventoryId: item.id,
        userId: null,
        eventType: "DEMO_RESET",
        previousStock: item.stock,
        newStock: item.stock,
        note: "Baseline demo inventory restored",
      });
    }

    await tx.insert(availabilitySignalsTable).values(
      initialInventory.map((item) => ({
        id: randomUUID(),
        inventoryId: item.id,
        signalType: "DEMO_RESET",
        score: 0,
        details: "Confidence is computed from stock, inventory freshness, historical availability, and store reliability.",
      })),
    );

    await tx.insert(ordersTable).values({
      id: "demo-order-001",
      customerId: "demo-customer",
      storeId: "store-demo",
      status: "PREPARING",
      total: 174,
      address: "Demo address · Demo City A",
      paymentMethod: "UPI",
      riskScore: 18,
      createdAt: hoursAgo(1),
    });
    await tx.insert(orderItemsTable).values([
      {
        id: randomUUID(),
        orderId: "demo-order-001",
        productId: "bread",
        quantity: 2,
        price: 48,
        confidenceAtOrder: 82,
        storeName: "Green Basket Market",
      },
      {
        id: randomUUID(),
        orderId: "demo-order-001",
        productId: "eggs",
        quantity: 1,
        price: 78,
        confidenceAtOrder: 93,
        storeName: "Green Basket Market",
      },
    ]);
    await tx.insert(orderStatusHistoryTable).values([
      {
        id: randomUUID(),
        orderId: "demo-order-001",
        status: "PLACED",
        note: "The customer placed this demo order.",
        createdAt: hoursAgo(1),
      },
      {
        id: randomUUID(),
        orderId: "demo-order-001",
        status: "STORE_CONFIRMED",
        note: "Green Basket Market confirmed the order.",
        createdAt: hoursAgo(0.8),
      },
      {
        id: randomUUID(),
        orderId: "demo-order-001",
        status: "PREPARING",
        note: "The store is preparing the items.",
        createdAt: hoursAgo(0.5),
      },
    ]);

    await tx.insert(alertsTable).values([
      {
        id: "alert-milk-stale",
        severity: "HIGH",
        type: "INVENTORY_STALE",
        storeId: "store-market",
        inventoryId: "inventory-milk",
        productName: "Fresh toned milk",
        reason: "Inventory is old and recent orders have failed.",
        recommendedAction: "Confirm the current shelf count.",
        status: "OPEN",
      },
      {
        id: "alert-bread-confidence",
        severity: "MEDIUM",
        type: "LOW_CONFIDENCE",
        storeId: "store-demo",
        inventoryId: "inventory-bread",
        productName: "Whole wheat bread",
        reason: "The stock count has not been refreshed recently.",
        recommendedAction: "Update inventory to refresh customer confidence.",
        status: "OPEN",
      },
    ]);

    const searches = [
      ...Array.from({ length: 14 }, (_, index) => ({
        id: randomUUID(),
        customerId: null,
        productId: "milk",
        searchTerm: "milk",
        available: index > 10,
        createdAt: hoursAgo(index + 1),
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: randomUUID(),
        customerId: null,
        productId: "tomatoes",
        searchTerm: "tomatoes",
        available: index > 3,
        createdAt: hoursAgo(index + 2),
      })),
      ...["paneer", "eggs", "bread", "rice", "milk"].map(
        (searchTerm, index) => ({
          id: randomUUID(),
          customerId: null,
          productId: searchTerm === "milk" ? "milk" : searchTerm,
          searchTerm,
          available: true,
          createdAt: hoursAgo(index + 3),
        }),
      ),
    ];
    await tx.insert(searchEventsTable).values(searches);
    await tx.insert(supportTicketsTable).values([
      { id: randomUUID(), category: "REFUND_STATUS" },
      { id: randomUUID(), category: "DELAYED_DELIVERY" },
      { id: randomUUID(), category: "UNAVAILABLE_PRODUCT" },
    ]);
    await tx
      .insert(demoStateTable)
      .values({
        id: "nova-pulse",
        resetCount: nextResetCount,
        lastResetAt: new Date(),
      })
      .onConflictDoUpdate({
        target: demoStateTable.id,
        set: { resetCount: nextResetCount, lastResetAt: new Date() },
      });
  });
}

export async function seedDatabase(): Promise<void> {
  await seedCore();
  const [state] = await db
    .select({ id: demoStateTable.id })
    .from(demoStateTable)
    .where(and(eq(demoStateTable.id, "nova-pulse")));
  if (!state) await resetDemoData(false);
}

export const demoInventorySeeds = initialInventory;
export const demoStores = storeSeeds;
export const demoProducts = productSeeds;