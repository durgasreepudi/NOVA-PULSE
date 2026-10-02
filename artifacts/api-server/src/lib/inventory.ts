import { eq } from "drizzle-orm";
import {
  db,
  inventoryTable,
  productsTable,
  recommendationsTable,
  storesTable,
} from "@workspace/db";

export async function loadInventoryRows() {
  return db
    .select({
      inventory: inventoryTable,
      product: productsTable,
      store: storesTable,
    })
    .from(inventoryTable)
    .innerJoin(productsTable, eq(inventoryTable.productId, productsTable.id))
    .innerJoin(storesTable, eq(inventoryTable.storeId, storesTable.id));
}

export type InventoryRow = Awaited<ReturnType<typeof loadInventoryRows>>[number];

export function availabilityConfidence(row: InventoryRow, now = Date.now()): number {
  if (!row.inventory.available || row.inventory.stock <= 0) return 0;
  const stockSignal = Math.min(100, (row.inventory.stock / 12) * 100);
  const ageHours = Math.max(
    0,
    (now - row.inventory.lastUpdated.getTime()) / (60 * 60 * 1000),
  );
  const freshness = Math.max(0, 100 - ageHours);
  const score =
    stockSignal * 0.45 +
    freshness * 0.35 +
    row.inventory.historicalAvailability * 0.12 +
    row.store.reliability * 0.08;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function confidenceLabel(confidence: number): string {
  if (confidence >= 90) return "Highly Available";
  if (confidence >= 75) return "Likely Available";
  if (confidence >= 50) return "Uncertain";
  return "Low Availability";
}

export function inventoryRisk(confidence: number): "HIGH" | "MEDIUM" | "LOW" {
  if (confidence < 50) return "HIGH";
  if (confidence < 75) return "MEDIUM";
  return "LOW";
}

function categoryPalette(category: string): { bg: string; accent: string } {
  const value = category.toLowerCase();
  if (value.includes("dairy")) return { bg: "#e7f0e9", accent: "#659477" };
  if (value.includes("bakery")) return { bg: "#f4e5d0", accent: "#be7148" };
  if (value.includes("produce")) return { bg: "#e4eddc", accent: "#6d985d" };
  return { bg: "#ece8d9", accent: "#a3834d" };
}

function productIllustration(category: string, name: string): string {
  const palette = categoryPalette(category);
  const initials = name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360"><rect width="480" height="360" rx="32" fill="${palette.bg}"/><circle cx="382" cy="75" r="84" fill="#ffffff" fill-opacity=".46"/><circle cx="86" cy="300" r="106" fill="${palette.accent}" fill-opacity=".12"/><path d="M0 272c68-33 117-14 175 3 67 20 146 15 305-41v126H0z" fill="${palette.accent}" fill-opacity=".18"/><rect x="155" y="75" width="170" height="206" rx="28" fill="#fffdf8" fill-opacity=".9"/><rect x="170" y="92" width="140" height="26" rx="13" fill="${palette.accent}" fill-opacity=".24"/><path d="M180 152h120M180 173h84" stroke="${palette.accent}" stroke-opacity=".48" stroke-width="8" stroke-linecap="round"/><circle cx="240" cy="222" r="33" fill="${palette.accent}" fill-opacity=".18"/><text x="240" y="232" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="${palette.accent}">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function toProduct(row: InventoryRow) {
  const confidence = availabilityConfidence(row);
  return {
    id: row.product.id,
    inventoryId: row.inventory.id,
    name: row.product.name,
    category: row.product.category,
    description: row.product.description,
    price: row.product.price,
    unit: row.product.unit,
    storeId: row.store.id,
    storeName: row.store.name,
    storeDistanceKm: row.store.distanceKm,
    storeReliability: row.store.reliability,
    stock: row.inventory.stock,
    confidence,
    availabilityLabel: confidenceLabel(confidence),
    lastUpdated: row.inventory.lastUpdated.toISOString(),
    deliveryMinutes: Math.round(23 + row.store.distanceKm * 4),
    image: row.product.image || productIllustration(row.product.category, row.product.name),
  };
}

export function toInventoryItem(row: InventoryRow) {
  const confidence = availabilityConfidence(row);
  return {
    id: row.inventory.id,
    productId: row.product.id,
    productName: row.product.name,
    category: row.product.category,
    price: row.product.price,
    unit: row.product.unit,
    stock: row.inventory.stock,
    confidence,
    availabilityLabel: confidenceLabel(confidence),
    lastUpdated: row.inventory.lastUpdated.toISOString(),
    recentFailures: row.inventory.recentFailures,
    risk: inventoryRisk(confidence),
  };
}

export async function findAlternatives(productId: string) {
  const sourceRows = await loadInventoryRows();
  const source = sourceRows.find((row) => row.product.id === productId);
  if (!source) return [];
  const sourceProduct = toProduct(source);
  const configured = await db
    .select({ productId: recommendationsTable.alternativeProductId })
    .from(recommendationsTable)
    .where(eq(recommendationsTable.productId, productId));
  const preferred = new Set(configured.map((item) => item.productId));

  return sourceRows
    .filter(
      (candidate) =>
        candidate.product.id !== productId &&
        candidate.inventory.available &&
        candidate.inventory.stock > 0 &&
        (candidate.product.category.toLowerCase() ===
          source.product.category.toLowerCase() ||
          preferred.has(candidate.product.id)),
    )
    .map((candidate) => {
      const alternative = toProduct(candidate);
      const priceSimilarity = Math.max(
        0,
        100 -
          (Math.abs(alternative.price - sourceProduct.price) /
            Math.max(sourceProduct.price, 1)) *
            100,
      );
      const categoryMatch =
        candidate.product.category.toLowerCase() ===
        source.product.category.toLowerCase();
      const ranking =
        alternative.confidence * 0.42 +
        priceSimilarity * 0.23 +
        candidate.store.reliability * 0.15 +
        Math.max(0, 100 - candidate.store.distanceKm * 15) * 0.1 +
        (categoryMatch || preferred.has(candidate.product.id) ? 10 : 0);
      return { product: alternative, ranking };
    })
    .sort((a, b) => b.ranking - a.ranking)
    .map((item) => item.product);
}

export async function getInventoryById(inventoryId: string) {
  const rows = await loadInventoryRows();
  return rows.find((row) => row.inventory.id === inventoryId) ?? null;
}

export async function getInventoryForProduct(productId: string) {
  const rows = await loadInventoryRows();
  return rows
    .filter(
      (row) =>
        row.product.id === productId &&
        row.inventory.available &&
        row.inventory.stock > 0,
    )
    .sort(
      (a, b) =>
        availabilityConfidence(b) - availabilityConfidence(a) ||
        a.store.distanceKm - b.store.distanceKm,
    )[0] ?? null;
}

export async function inventoryForStore(storeId: string) {
  const rows = await loadInventoryRows();
  return rows.filter((row) => row.store.id === storeId);
}

export async function inventoryForProductAtStore(
  productId: string,
  storeId: string,
) {
  const rows = await loadInventoryRows();
  return (
    rows.find(
      (row) =>
        row.product.id === productId &&
        row.store.id === storeId &&
        row.inventory.stock > 0,
    ) ?? null
  );
}