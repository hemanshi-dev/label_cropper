import type { Parser } from "./types";
import type { TextLine } from "./text-extractor";

const normalizeText = (value: string): string =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

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

function getFirstNonEmptyLineAfter(
  lines: TextLine[],
  label: string,
): string {
  const labelLower = label.toLowerCase();

  const index = lines.findIndex((line) =>
    line.text.toLowerCase().includes(labelLower),
  );

  if (index < 0) return "";

  const current = lines[index].text;
  const labelIndex = current.toLowerCase().indexOf(labelLower);
  const sameLine = current
    .slice(labelIndex + label.length)
    .replace(/^\s*:\s*/, "");

  if (cleanValue(sameLine)) {
    return cleanValue(sameLine);
  }

  for (let i = index + 1; i < lines.length; i += 1) {
    const value = cleanValue(lines[i].text);
    if (value) return value;
  }

  return "";
}

function extractOrderId(text: string): string {
  const match = text.match(
    /Order\s*(?:Number|ID)\s*:\s*(\d{3}\s*-\s*\d{7}\s*-\s*\d{7})/i,
  );

  return match?.[1]?.replace(/\s+/g, "") ?? "";
}

function extractInvoiceNumber(text: string): string {
  const match = text.match(
    /Invoice\s*Number\s*:\s*([A-Z0-9][A-Z0-9/_-]*)/i,
  );

  return cleanValue(match?.[1] ?? "");
}

function extractSkuList(text: string): string[] {
  /*
   * Amazon invoice item format:
   *
   * Product title | B0XXXXXXXX ( SELLER-SKU )
   * HSN:123456
   *
   * B0XXXXXXXX is the ASIN. The value inside the final parentheses is
   * the seller SKU that must be used for sorting.
   */
  const matches = [
    ...text.matchAll(
      /\(\s*([^()\r\n]+?)\s*\)\s*(?:\r?\n|\s)*HSN\s*:/gi,
    ),
  ];

  return [
    ...new Set(
      matches
        .map((match) => cleanValue(match[1] ?? ""))
        .filter(Boolean),
    ),
  ];
}

function extractTotalQuantity(text: string): number {
  const inline = normalizeInline(text);

  /*
   * Do not anchor quantity extraction only after HSN.
   *
   * Amazon PDFs do not always return text in the same order:
   *
   * Layout A:
   * HSN:34011190 ₹94.29 -₹9.43 2 ₹169.72 5% IGST
   *
   * Layout B:
   * ₹94.29 -₹9.43 2 ₹169.72 5% IGST ... HSN:34011190
   *
   * The reliable sequence is:
   * Unit Price -> optional Discount -> Qty -> Net Amount -> Tax Rate
   */
  const itemRowPattern =
    /(?:₹\s*)?(\d[\d,]*\.\d{1,2})\s+(?:-\s*(?:₹\s*)?(\d[\d,]*\.\d{1,2})\s+)?([1-9]\d*)\s+(?:₹\s*)?(\d[\d,]*\.\d{1,2})\s+\d+(?:\.\d+)?\s*%/gi;

  const rowMatches = [...inline.matchAll(itemRowPattern)];

  const rowQuantities = rowMatches
    .map((match) => Number(match[3]))
    .filter(
      (quantity) =>
        Number.isInteger(quantity) &&
        quantity > 0 &&
        quantity <= 999,
    );

  if (rowQuantities.length > 0) {
    return rowQuantities.reduce(
      (total, quantity) => total + quantity,
      0,
    );
  }

  /*
   * Fallback for PDFs where the currency values are split strangely.
   * Match the item area around HSN in either direction and look for:
   * price, optional discount, quantity, net amount.
   */
  const hsnIndex = inline.search(/HSN\s*:\s*\d+/i);

  if (hsnIndex >= 0) {
    const itemWindow = inline.slice(
      Math.max(0, hsnIndex - 500),
      Math.min(inline.length, hsnIndex + 500),
    );

    const fallbackMatch = itemWindow.match(
      /(?:₹\s*)?\d[\d,]*\.\d{1,2}\s+(?:-\s*(?:₹\s*)?\d[\d,]*\.\d{1,2}\s+)?([1-9]\d*)\s+(?:₹\s*)?\d[\d,]*\.\d{1,2}/i,
    );

    if (fallbackMatch?.[1]) {
      const quantity = Number(fallbackMatch[1]);

      if (
        Number.isInteger(quantity) &&
        quantity > 0 &&
        quantity <= 999
      ) {
        return quantity;
      }
    }
  }

  console.warn(
    "Amazon quantity was not detected; defaulting to 1.",
    {
      preview: inline.slice(0, 1000),
    },
  );

  return 1;
}

function extractProductName(text: string): string {
  const inline = normalizeInline(text);

  const match = inline.match(
    /\b1\s+(.+?)\|\s*B0[A-Z0-9]{8,}\s*\(/i,
  );

  return cleanValue(match?.[1] ?? "");
}

export const parseAmazon: Parser = (pageText, pageIndex) => {
  const normalized = normalizeText(pageText);
  const inline = normalizeInline(pageText);

  /*
   * The shipping-label pages in the supplied Amazon PDF are image-only.
   * Invoice pages have a real text layer, so OCR is not needed for SKU,
   * order number or quantity extraction.
   */
  const isInvoicePage =
    /Tax Invoice\/Bill of Supply\/Cash Memo/i.test(inline) ||
    (/Order\s*Number\s*:/i.test(inline) &&
      /Invoice\s*Number\s*:/i.test(inline));

  if (!isInvoicePage) {
    return null;
  }

  const lines: TextLine[] = normalized
    .split(/\r?\n/)
    .map((text, index) => ({
      text: text.trim(),
      y: -index,
      x: 0,
    }))
    .filter((line) => line.text.length > 0);

  const orderId = extractOrderId(inline);
  const invoiceNumber = extractInvoiceNumber(inline);
  const skuList = extractSkuList(normalized);
  const sku = skuList.join(", ");
  const quantity = extractTotalQuantity(inline);
  const productName = extractProductName(inline);

  const customerName =
    getFirstNonEmptyLineAfter(lines, "Shipping Address") ||
    getFirstNonEmptyLineAfter(lines, "Billing Address");

  const paymentModeMatch = inline.match(
    /Mode\s*of\s*Payment\s*:\s*([A-Za-z]+)/i,
  );

  if (!orderId || !sku) {
    console.warn("Amazon invoice parser could not extract required data", {
      invoicePage: pageIndex + 1,
      orderId,
      sku,
      preview: inline.slice(0, 500),
    });

    return null;
  }

  /*
   * extractOrders passes a zero-based invoice page index.
   *
   * Invoice page index 1 = PDF page 2, whose label is PDF page 1.
   * OrderData.page is one-based, therefore pageIndex itself is the
   * previous label's one-based page number.
   */
  const labelPageNumber = Math.max(1, pageIndex);

  return {
    page: labelPageNumber,
    platform: "amazon",
    orderId,
    invoiceNumber,
    sku,
    productName,
    quantity,
    courier: null,
    awbNumber: null,
    customerName,
    paymentMode: paymentModeMatch?.[1]?.toUpperCase() ?? null,
    isMultiOrder: quantity > 1 || skuList.length > 1,
  };
};

// import type { Parser } from "./types";
// import type { TextLine } from "./text-extractor";

// const normalizeText = (value: string): string =>
//   value
//     .replace(/\u00a0/g, " ")
//     .replace(/[ \t]+/g, " ")
//     .replace(/\s*\n\s*/g, "\n")
//     .trim();

// const normalizeInline = (value: string): string =>
//   value
//     .replace(/\u00a0/g, " ")
//     .replace(/\s+/g, " ")
//     .trim();

// const cleanValue = (value: string): string =>
//   normalizeInline(value)
//     .replace(/^[|:,\-\s]+/, "")
//     .replace(/[|:,\-\s]+$/, "")
//     .trim();

// function getFirstNonEmptyLineAfter(
//   lines: TextLine[],
//   label: string,
// ): string {
//   const labelLower = label.toLowerCase();

//   const index = lines.findIndex((line) =>
//     line.text.toLowerCase().includes(labelLower),
//   );

//   if (index < 0) return "";

//   const current = lines[index].text;
//   const labelIndex = current.toLowerCase().indexOf(labelLower);
//   const sameLine = current
//     .slice(labelIndex + label.length)
//     .replace(/^\s*:\s*/, "");

//   if (cleanValue(sameLine)) {
//     return cleanValue(sameLine);
//   }

//   for (let i = index + 1; i < lines.length; i += 1) {
//     const value = cleanValue(lines[i].text);
//     if (value) return value;
//   }

//   return "";
// }

// function extractOrderId(text: string): string {
//   const match = text.match(
//     /Order\s*(?:Number|ID)\s*:\s*(\d{3}\s*-\s*\d{7}\s*-\s*\d{7})/i,
//   );

//   return match?.[1]?.replace(/\s+/g, "") ?? "";
// }

// function extractInvoiceNumber(text: string): string {
//   const match = text.match(
//     /Invoice\s*Number\s*:\s*([A-Z0-9][A-Z0-9/_-]*)/i,
//   );

//   return cleanValue(match?.[1] ?? "");
// }

// function extractSkuList(text: string): string[] {
//   /*
//    * Amazon invoice item format:
//    *
//    * Product title | B0XXXXXXXX ( SELLER-SKU )
//    * HSN:123456
//    *
//    * B0XXXXXXXX is the ASIN. The value inside the final parentheses is
//    * the seller SKU that must be used for sorting.
//    */
//   const matches = [
//     ...text.matchAll(
//       /\(\s*([^()\r\n]+?)\s*\)\s*(?:\r?\n|\s)*HSN\s*:/gi,
//     ),
//   ];

//   return [
//     ...new Set(
//       matches
//         .map((match) => cleanValue(match[1] ?? ""))
//         .filter(Boolean),
//     ),
//   ];
// }

// function extractTotalQuantity(text: string): number {
//   const inline = normalizeInline(text);

//   /*
//    * Supported examples:
//    * HSN:330590 ₹170.48 1 ₹170.48 5% IGST
//    * HSN:34011190 ₹94.29 -₹9.43 2 ₹169.72 5% IGST
//    *
//    * Currency symbols are optional because PDF.js may split/drop them.
//    */
//   const matches = [
//     ...inline.matchAll(
//       /HSN\s*:\s*\d+\s+(?:₹\s*)?[\d,.]+\s+(?:(?:-\s*)?(?:₹\s*)?[\d,.]+\s+)?(\d+)\s+(?:₹\s*)?[\d,.]+\s+\d+(?:\.\d+)?\s*%/gi,
//     ),
//   ];

//   const quantities = matches
//     .map((match) => Number(match[1]))
//     .filter((quantity) => Number.isFinite(quantity) && quantity > 0);

//   if (quantities.length > 0) {
//     return quantities.reduce((sum, quantity) => sum + quantity, 0);
//   }

//   /*
//    * More permissive fallback. Limit the search to the item area after HSN
//    * and before TOTAL so invoice totals/order numbers are not treated as qty.
//    */
//   const itemSections = [
//     ...inline.matchAll(
//       /HSN\s*:\s*\d+\s+([\s\S]*?)(?=HSN\s*:|TOTAL\s*:)/gi,
//     ),
//   ];

//   for (const section of itemSections) {
//     const value = section[1] ?? "";

//     const withDiscount = value.match(
//       /(?:₹\s*)?[\d,.]+\s+(?:-\s*)?(?:₹\s*)?[\d,.]+\s+(\d+)\s+(?:₹\s*)?[\d,.]+/i,
//     );

//     if (withDiscount?.[1]) {
//       const quantity = Number(withDiscount[1]);
//       if (Number.isFinite(quantity) && quantity > 0) return quantity;
//     }

//     const withoutDiscount = value.match(
//       /(?:₹\s*)?[\d,.]+\s+(\d+)\s+(?:₹\s*)?[\d,.]+/i,
//     );

//     if (withoutDiscount?.[1]) {
//       const quantity = Number(withoutDiscount[1]);
//       if (Number.isFinite(quantity) && quantity > 0) return quantity;
//     }
//   }

//   return 1;
// }

// function extractProductName(text: string): string {
//   const inline = normalizeInline(text);

//   const match = inline.match(
//     /\b1\s+(.+?)\|\s*B0[A-Z0-9]{8,}\s*\(/i,
//   );

//   return cleanValue(match?.[1] ?? "");
// }

// export const parseAmazon: Parser = (pageText, pageIndex) => {
//   const normalized = normalizeText(pageText);
//   const inline = normalizeInline(pageText);

//   /*
//    * The shipping-label pages in the supplied Amazon PDF are image-only.
//    * Invoice pages have a real text layer, so OCR is not needed for SKU,
//    * order number or quantity extraction.
//    */
//   const isInvoicePage =
//     /Tax Invoice\/Bill of Supply\/Cash Memo/i.test(inline) ||
//     (/Order\s*Number\s*:/i.test(inline) &&
//       /Invoice\s*Number\s*:/i.test(inline));

//   if (!isInvoicePage) {
//     return null;
//   }

//   const lines: TextLine[] = normalized
//     .split(/\r?\n/)
//     .map((text, index) => ({
//       text: text.trim(),
//       y: -index,
//       x: 0,
//     }))
//     .filter((line) => line.text.length > 0);

//   const orderId = extractOrderId(inline);
//   const invoiceNumber = extractInvoiceNumber(inline);
//   const skuList = extractSkuList(normalized);
//   const sku = skuList.join(", ");
//   const quantity = extractTotalQuantity(inline);
//   const productName = extractProductName(inline);

//   const customerName =
//     getFirstNonEmptyLineAfter(lines, "Shipping Address") ||
//     getFirstNonEmptyLineAfter(lines, "Billing Address");

//   const paymentModeMatch = inline.match(
//     /Mode\s*of\s*Payment\s*:\s*([A-Za-z]+)/i,
//   );

//   if (!orderId || !sku) {
//     console.warn("Amazon invoice parser could not extract required data", {
//       invoicePage: pageIndex + 1,
//       orderId,
//       sku,
//       preview: inline.slice(0, 500),
//     });

//     return null;
//   }

//   /*
//    * extractOrders passes a zero-based invoice page index.
//    *
//    * Invoice page index 1 = PDF page 2, whose label is PDF page 1.
//    * OrderData.page is one-based, therefore pageIndex itself is the
//    * previous label's one-based page number.
//    */
//   const labelPageNumber = Math.max(1, pageIndex);

//   return {
//     page: labelPageNumber,
//     platform: "amazon",
//     orderId,
//     invoiceNumber,
//     sku,
//     productName,
//     quantity,
//     courier: null,
//     awbNumber: null,
//     customerName,
//     paymentMode: paymentModeMatch?.[1]?.toUpperCase() ?? null,
//     isMultiOrder: quantity > 1 || skuList.length > 1,
//   };
// };