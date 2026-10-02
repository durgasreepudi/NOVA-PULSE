import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const rolesTable = pgTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const storesTable = pgTable("stores", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  city: text("city").notNull(),
  distanceKm: doublePrecision("distance_km").notNull().default(1),
  reliability: integer("reliability").notNull().default(80),
  createdAt: createdAt(),
});

export const usersTable = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    roleId: text("role_id")
      .notNull()
      .references(() => rolesTable.id),
    storeId: text("store_id").references(() => storesTable.id),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)],
);

export const productsTable = pgTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull().default(""),
  price: doublePrecision("price").notNull(),
  unit: text("unit").notNull().default("each"),
  image: text("image").notNull().default(""),
  createdAt: createdAt(),
});

export const inventoryTable = pgTable(
  "inventory",
  {
    id: text("id").primaryKey(),
    storeId: text("store_id")
      .notNull()
      .references(() => storesTable.id),
    productId: text("product_id")
      .notNull()
      .references(() => productsTable.id),
    stock: integer("stock").notNull().default(0),
    available: boolean("available").notNull().default(true),
    historicalAvailability: integer("historical_availability")
      .notNull()
      .default(80),
    recentFailures: integer("recent_failures").notNull().default(0),
    attemptedOrders: integer("attempted_orders").notNull().default(0),
    fulfilledOrders: integer("fulfilled_orders").notNull().default(0),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("inventory_store_product_idx").on(
      table.storeId,
      table.productId,
    ),
    index("inventory_product_idx").on(table.productId),
  ],
);

export const inventoryEventsTable = pgTable(
  "inventory_events",
  {
    id: text("id").primaryKey(),
    inventoryId: text("inventory_id")
      .notNull()
      .references(() => inventoryTable.id),
    userId: text("user_id").references(() => usersTable.id),
    eventType: text("event_type").notNull(),
    previousStock: integer("previous_stock").notNull(),
    newStock: integer("new_stock").notNull(),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (table) => [index("inventory_events_inventory_idx").on(table.inventoryId)],
);

export const availabilitySignalsTable = pgTable(
  "availability_signals",
  {
    id: text("id").primaryKey(),
    inventoryId: text("inventory_id")
      .notNull()
      .references(() => inventoryTable.id),
    signalType: text("signal_type").notNull(),
    score: integer("score").notNull(),
    details: text("details").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("availability_signals_inventory_idx").on(table.inventoryId),
  ],
);

export const recommendationsTable = pgTable(
  "recommendations",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => productsTable.id),
    alternativeProductId: text("alternative_product_id")
      .notNull()
      .references(() => productsTable.id),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("recommendations_pair_idx").on(
      table.productId,
      table.alternativeProductId,
    ),
  ],
);

export const ordersTable = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references(() => usersTable.id),
    storeId: text("store_id")
      .notNull()
      .references(() => storesTable.id),
    status: text("status").notNull().default("PLACED"),
    total: doublePrecision("total").notNull(),
    address: text("address").notNull(),
    paymentMethod: text("payment_method").notNull(),
    riskScore: integer("risk_score").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    index("orders_customer_idx").on(table.customerId),
    index("orders_store_idx").on(table.storeId),
  ],
);

export const orderItemsTable = pgTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => ordersTable.id),
  productId: text("product_id")
    .notNull()
    .references(() => productsTable.id),
  quantity: integer("quantity").notNull(),
  price: doublePrecision("price").notNull(),
  confidenceAtOrder: integer("confidence_at_order").notNull(),
  storeName: text("store_name").notNull(),
});

export const orderStatusHistoryTable = pgTable(
  "order_status_history",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => ordersTable.id),
    status: text("status").notNull(),
    note: text("note").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("order_history_order_idx").on(table.orderId)],
);

export const alertsTable = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    severity: text("severity").notNull(),
    type: text("type").notNull(),
    storeId: text("store_id")
      .notNull()
      .references(() => storesTable.id),
    inventoryId: text("inventory_id").references(() => inventoryTable.id),
    productName: text("product_name").notNull(),
    reason: text("reason").notNull(),
    recommendedAction: text("recommended_action").notNull(),
    status: text("status").notNull().default("OPEN"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("alerts_status_idx").on(table.status)],
);

export const searchEventsTable = pgTable(
  "search_events",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").references(() => usersTable.id),
    productId: text("product_id").references(() => productsTable.id),
    searchTerm: text("search_term").notNull(),
    available: boolean("available").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [index("search_events_term_idx").on(table.searchTerm)],
);

export const supportTicketsTable = pgTable("support_tickets", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  status: text("status").notNull().default("OPEN"),
  orderId: text("order_id").references(() => ordersTable.id),
  createdAt: createdAt(),
});

export const demoStateTable = pgTable("demo_state", {
  id: text("id").primaryKey(),
  resetCount: integer("reset_count").notNull().default(0),
  lastResetAt: timestamp("last_reset_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertRoleSchema = createInsertSchema(rolesTable);
export const insertStoreSchema = createInsertSchema(storesTable);
export const insertUserSchema = createInsertSchema(usersTable);
export const insertProductSchema = createInsertSchema(productsTable);
export const insertInventorySchema = createInsertSchema(inventoryTable);
export const insertInventoryEventSchema =
  createInsertSchema(inventoryEventsTable);
export const insertAvailabilitySignalSchema =
  createInsertSchema(availabilitySignalsTable);
export const insertRecommendationSchema =
  createInsertSchema(recommendationsTable);
export const insertOrderSchema = createInsertSchema(ordersTable);
export const insertOrderItemSchema = createInsertSchema(orderItemsTable);
export const insertOrderStatusHistorySchema =
  createInsertSchema(orderStatusHistoryTable);
export const insertAlertSchema = createInsertSchema(alertsTable);
export const insertSearchEventSchema = createInsertSchema(searchEventsTable);
export const insertSupportTicketSchema =
  createInsertSchema(supportTicketsTable);
export const insertDemoStateSchema = createInsertSchema(demoStateTable);

export type InsertRole = z.infer<typeof insertRoleSchema>;
export type InsertStore = z.infer<typeof insertStoreSchema>;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type InsertInventoryEvent = z.infer<typeof insertInventoryEventSchema>;
export type InsertAvailabilitySignal = z.infer<
  typeof insertAvailabilitySignalSchema
>;
export type InsertRecommendation = z.infer<typeof insertRecommendationSchema>;
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type InsertOrderItem = z.infer<typeof insertOrderItemSchema>;
export type InsertOrderStatusHistory = z.infer<
  typeof insertOrderStatusHistorySchema
>;
export type InsertAlert = z.infer<typeof insertAlertSchema>;
export type InsertSearchEvent = z.infer<typeof insertSearchEventSchema>;
export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;
export type InsertDemoState = z.infer<typeof insertDemoStateSchema>;