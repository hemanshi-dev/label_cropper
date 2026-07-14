import type { Parser } from "./types";
import type { TextLine } from "./text-extractor";
import { extractAfterLabel, extractQuantity } from "./text-extractor";

export const parseMeesho: Parser = (pageText, pageIndex) => {
  const lines: TextLine[] = pageText
    .split("\n")
    .map((text, i) => ({ text, y: -i, x: 0 }));

  const orderId = extractAfterLabel(lines, "Order ID") ?? extractAfterLabel(lines, "Order No") ?? "";
  const invoiceNumber = extractAfterLabel(lines, "Invoice") ?? extractAfterLabel(lines, "Invoice No") ?? "";
  const sku = extractAfterLabel(lines, "SKU") ?? "";
  const productName = extractAfterLabel(lines, "Product") ?? "";
  const quantity = extractQuantity(lines);
  const courier = extractAfterLabel(lines, "Courier") ?? extractAfterLabel(lines, "Partner") ?? extractAfterLabel(lines, "Logistics") ?? null;
  const awbNumber = extractAfterLabel(lines, "AWB") ?? extractAfterLabel(lines, "Tracking") ?? extractAfterLabel(lines, "Barcode") ?? null;
  const customerName = extractAfterLabel(lines, "Ship To") ?? extractAfterLabel(lines, "Customer Name") ?? extractAfterLabel(lines, "Buyer") ?? "";
  const paymentMode = extractAfterLabel(lines, "Payment") ?? extractAfterLabel(lines, "COD") ?? null;

  if (!orderId && !sku) return null;

  return {
    page: pageIndex + 1,
    platform: "meesho",
    orderId,
    invoiceNumber,
    sku,
    productName,
    quantity,
    courier,
    awbNumber,
    customerName,
    paymentMode,
    isMultiOrder: false,
  };
};
