import type { Parser } from "./types";
import type { TextLine } from "./text-extractor";

const normalizeInline = (value: string): string =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const cleanValue = (value: string): string =>
  normalizeInline(value)
    .replace(/^[|:,\-\s]+/, "")
    .replace(/[|:,\-\s]+$/, "")
    .trim();

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractOrderId(text: string): string {
  return text.match(/\bOD\d{12,}\b/i)?.[0]?.toUpperCase() ?? "";
}

function extractInvoiceNumber(text: string): string {
  const inline = normalizeInline(text);

  const labelledMatch = inline.match(
    /Invoice\s*No\s*:\s*([A-Z0-9/_-]{6,})/i,
  );

  const labelledValue = cleanValue(
    labelledMatch?.[1] ?? "",
  );

  /*
   * PDF.js can return the right-side GSTIN text immediately after
   * "Invoice No:" because of column ordering. Reject known labels and
   * fall back to the invoice-number format, e.g. LWAC04S270000165.
   */
  if (
    labelledValue &&
    !/^(GSTIN|PAN|INVOICE|DATE)$/i.test(labelledValue)
  ) {
    return labelledValue;
  }

  const directMatch = text.match(
    /\b[A-Z]{3,8}\d{2}[A-Z]\d{6,}\b/i,
  );

  return cleanValue(directMatch?.[0] ?? "");
}

function extractSkuList(text: string): string[] {
  /*
   * Flipkart label table format:
   *
   * SKU ID | Description QTY
   * 1 seller-sku-1 | Product name 1
   * 2 seller-sku-1 | Product name 1
   */
  const labelTableMatches = [
    ...text.matchAll(
      /(?:^|\n)\s*\d+\s+([A-Za-z0-9][A-Za-z0-9._/-]*)\s*\|/gim,
    ),
  ].map((match) => cleanValue(match[1] ?? ""));

  /*
   * Invoice product format fallback:
   *
   * Product title | seller-sku-1 | Not eligible for return
   */
  const invoiceMatches = [
    ...text.matchAll(
      /\|\s*([A-Za-z0-9][A-Za-z0-9._/-]*)\s*\|\s*(?:Not eligible|IMEI|HSN)/gim,
    ),
  ].map((match) => cleanValue(match[1] ?? ""));

  return unique([...labelTableMatches, ...invoiceMatches]);
}

function extractTotalQuantity(text: string): number {
  const inline = normalizeInline(text);

  /*
   * This is the most reliable Flipkart value because Handling Fee rows
   * also contain Qty=1 and must not be added to the product quantity.
   */
  const totalMatch = inline.match(
    /TOTAL\s*QTY\s*:\s*(\d+)/i,
  );

  if (totalMatch?.[1]) {
    const quantity = Number(totalMatch[1]);

    if (Number.isInteger(quantity) && quantity > 0) {
      return quantity;
    }
  }

  /*
   * Fallback: add the QTY values from the top SKU table only.
   */
  const skuSection =
    text.match(
      /SKU\s*ID\s*\|\s*Description\s*QTY([\s\S]*?)(?=Tax\s*Invoice|Invoice\s*No|Not\s*for\s*resale)/i,
    )?.[1] ?? "";

  const rowMatches = [
    ...skuSection.matchAll(
      /(?:^|\n)\s*\d+\s+[A-Za-z0-9][A-Za-z0-9._/-]*\s*\|[\s\S]*?\s([1-9]\d*)\s*(?=\n|$)/gim,
    ),
  ];

  const quantities = rowMatches
    .map((match) => Number(match[1]))
    .filter(
      (quantity) =>
        Number.isInteger(quantity) && quantity > 0,
    );

  if (quantities.length > 0) {
    return quantities.reduce(
      (total, quantity) => total + quantity,
      0,
    );
  }

  return 1;
}

function extractCustomerName(text: string): string {
  const match = text.match(
    /Shipping\/Customer\s*address\s*:\s*(?:\r?\n|\s)*Name\s*:\s*([^\r\n,]+)/i,
  );

  return cleanValue(match?.[1] ?? "");
}

function extractProductName(text: string): string {
  const match =
    text.match(
      /(?:^|\n)\s*1\s+[A-Za-z0-9][A-Za-z0-9._/-]*\s*\|\s*([^\r\n]+)/im,
    ) ??
    text.match(
      /Product\s+Description[\s\S]*?\n\s*([^\r\n|]+(?:\s+[^\r\n|]+)*)\s*\|/i,
    );

  return cleanValue(match?.[1] ?? "");
}

function extractCourier(text: string): string | null {
  const match = text.match(
    /\b(E-?Kart Logistics|Ekart Logistics)\b/i,
  );

  return match?.[1]
    ? match[1].replace(/^E-?Kart/i, "E-Kart")
    : null;
}

function extractAwb(text: string): string | null {
  const match = text.match(
    /AWB\s*No\.?\s*[:.]?\s*([A-Z0-9-]+)/i,
  );

  return cleanValue(match?.[1] ?? "") || null;
}

function extractPaymentMode(text: string): string | null {
  const match = normalizeInline(text).match(
    /\b(COD|PREPAID)\b/i,
  );

  return match?.[1]?.toUpperCase() ?? null;
}

export const parseFlipkart: Parser = (
  pageText,
  pageIndex,
) => {
  const lines: TextLine[] = pageText
    .split(/\r?\n/)
    .map((text, index) => ({
      text: text.trim(),
      y: -index,
      x: 0,
    }))
    .filter((line) => line.text.length > 0);

  // Keep this variable so the parser shape remains compatible
  // with the other platform parsers and debugging is easier.
  void lines;

  const orderId = extractOrderId(pageText);
  const invoiceNumber = extractInvoiceNumber(pageText);
  const skuList = extractSkuList(pageText);
  const sku = skuList.join(", ");
  const quantity = extractTotalQuantity(pageText);
  const productName = extractProductName(pageText);
  const courier = extractCourier(pageText);
  const awbNumber = extractAwb(pageText);
  const customerName = extractCustomerName(pageText);
  const paymentMode = extractPaymentMode(pageText);

  if (!orderId || !sku) {
    console.warn(
      "Flipkart parser could not extract required data",
      {
        page: pageIndex + 1,
        orderId,
        sku,
        preview: normalizeInline(pageText).slice(0, 700),
      },
    );

    return null;
  }

  return {
    page: pageIndex + 1,
    platform: "flipkart",
    orderId,
    invoiceNumber,
    sku,
    productName,
    quantity,
    courier,
    awbNumber,
    customerName,
    paymentMode,

    /*
     * Flipkart single/multi filtering is quantity-based.
     * The same SKU appearing twice with Qty 1 + Qty 1 is a multi order.
     */
    isMultiOrder:
      quantity > 1 || skuList.length > 1,
  };
};


// import type { Parser } from "./types";
// import type { TextLine } from "./text-extractor";
// import { extractAfterLabel, extractQuantity } from "./text-extractor";

// export const parseFlipkart: Parser = (pageText, pageIndex) => {
//   const lines: TextLine[] = pageText
//     .split("\n")
//     .map((text, i) => ({ text, y: -i, x: 0 }));

//   const orderId = extractAfterLabel(lines, "Order ID")
//     ?? pageText.match(/\bOD\d{12,}\b/i)?.[0]
//     ?? "";
//   const invoiceNumber = extractAfterLabel(lines, "Invoice") ?? extractAfterLabel(lines, "Invoice No") ?? "";
//   const sku = extractAfterLabel(lines, "SKU") ?? "";
//   const productName = extractAfterLabel(lines, "Product") ?? "";
//   const quantity = extractQuantity(lines);
//   const courier = extractAfterLabel(lines, "Courier") ?? extractAfterLabel(lines, "Partner") ?? null;
//   const awbNumber = extractAfterLabel(lines, "AWB") ?? extractAfterLabel(lines, "Tracking") ?? null;
//   const customerName = extractAfterLabel(lines, "Ship To") ?? extractAfterLabel(lines, "Customer Name") ?? "";
//   const paymentMode = extractAfterLabel(lines, "Payment") ?? extractAfterLabel(lines, "COD") ?? null;

//   if (!orderId && !sku) return null;

//   return {
//     page: pageIndex + 1,
//     platform: "flipkart",
//     orderId,
//     invoiceNumber,
//     sku,
//     productName,
//     quantity,
//     courier,
//     awbNumber,
//     customerName,
//     paymentMode,
//     isMultiOrder: false,
//   };
// };
