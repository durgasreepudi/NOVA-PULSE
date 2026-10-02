import { desc, eq } from "drizzle-orm";
import {
  db,
  orderItemsTable,
  orderStatusHistoryTable,
  ordersTable,
  productsTable,
  storesTable,
  usersTable,
} from "@workspace/db";
import type { SessionUser } from "./auth";

type OrderRow = {
  order: typeof ordersTable.$inferSelect;
  customerName: string;
  customerEmail: string;
  storeName: string;
};

async function getOrderDetails(row: OrderRow) {
  const [items, history] = await Promise.all([
    db
      .select({ item: orderItemsTable, productName: productsTable.name })
      .from(orderItemsTable)
      .innerJoin(productsTable, eq(orderItemsTable.productId, productsTable.id))
      .where(eq(orderItemsTable.orderId, row.order.id)),
    db
      .select()
      .from(orderStatusHistoryTable)
      .where(eq(orderStatusHistoryTable.orderId, row.order.id))
      .orderBy(orderStatusHistoryTable.createdAt),
  ]);
  return {
    id: row.order.id,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    storeId: row.order.storeId,
    storeName: row.storeName,
    status: row.order.status,
    total: row.order.total,
    address: row.order.address,
    paymentMethod: row.order.paymentMethod,
    riskScore: row.order.riskScore,
    createdAt: row.order.createdAt.toISOString(),
    items: items.map(({ item, productName }) => ({
      productId: item.productId,
      productName,
      quantity: item.quantity,
      price: item.price,
      confidenceAtOrder: item.confidenceAtOrder,
      storeName: item.storeName,
    })),
    history: history.map((event) => ({
      status: event.status,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

export async function listOrdersForUser(user: SessionUser) {
  let query = db
    .select({
      order: ordersTable,
      customerName: usersTable.name,
      customerEmail: usersTable.email,
      storeName: storesTable.name,
    })
    .from(ordersTable)
    .innerJoin(usersTable, eq(ordersTable.customerId, usersTable.id))
    .innerJoin(storesTable, eq(ordersTable.storeId, storesTable.id))
    .$dynamic();

  if (user.role === "CUSTOMER") {
    query = query.where(eq(ordersTable.customerId, user.id));
  } else if (user.role === "STORE" && user.storeId) {
    query = query.where(eq(ordersTable.storeId, user.storeId));
  } else if (user.role === "STORE") {
    return [];
  }

  const rows = await query.orderBy(desc(ordersTable.createdAt));
  return Promise.all(rows.map(getOrderDetails));
}

export async function getOrderForUser(
  orderId: string,
  user: SessionUser,
): Promise<Awaited<ReturnType<typeof listOrdersForUser>>[number] | null> {
  const [row] = await db
    .select({
      order: ordersTable,
      customerName: usersTable.name,
      customerEmail: usersTable.email,
      storeName: storesTable.name,
    })
    .from(ordersTable)
    .innerJoin(usersTable, eq(ordersTable.customerId, usersTable.id))
    .innerJoin(storesTable, eq(ordersTable.storeId, storesTable.id))
    .where(eq(ordersTable.id, orderId));
  if (!row) return null;
  if (
    (user.role === "CUSTOMER" && row.order.customerId !== user.id) ||
    (user.role === "STORE" && row.order.storeId !== user.storeId)
  ) {
    return null;
  }
  return getOrderDetails(row);
}