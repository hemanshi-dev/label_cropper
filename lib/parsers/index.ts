import type { PlatformID } from "../platforms";
import type { OrderData, Parser } from "./types";
import { parseAmazon } from "./amazon";
import { parseFlipkart } from "./flipkart";
import { parseMeesho } from "./meesho";
import { extractTextFromPDF } from "./text-extractor";

const parsers: Record<PlatformID, Parser> = {
  amazon: parseAmazon,
  flipkart: parseFlipkart,
  meesho: parseMeesho,
};

export async function extractOrders(
  pdfBytes: ArrayBuffer,
  platform: PlatformID
): Promise<OrderData[]> {
  const allPagesText = await extractTextFromPDF(pdfBytes);
  const parser = parsers[platform];

  console.log("DEBUG extractOrders - allPagesText:", allPagesText.length, "pages");
  allPagesText.forEach((lines, i) => {
    console.log(`DEBUG page ${i}:`, lines.length, "lines", lines.slice(0, 3));
  });

  const orders: OrderData[] = [];

  for (let i = 0; i < allPagesText.length; i++) {
    const pageLines = allPagesText[i];
    const fullText = pageLines.map((l) => l.text).join("\n");

    const order = parser(fullText, i);
    console.log(`DEBUG parser page ${i}:`, order ? "found" : "null", order?.orderId, order?.sku);
    if (order) {
      orders.push(order);
    }
  }

  const orderIdCounts = orders.reduce<Record<string, number>>((counts, order) => {
    const key = normalizeOrderId(order.orderId);
    if (!key) return counts;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  orders.forEach((order) => {
    const key = normalizeOrderId(order.orderId);
    order.isMultiOrder = order.quantity > 1 || Boolean(key && orderIdCounts[key] > 1);
  });

  return orders;
}

function normalizeOrderId(orderId: string): string {
  return orderId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}
