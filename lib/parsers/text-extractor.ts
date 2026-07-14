export interface TextLine {
  text: string;
  y: number;
  x: number;
}

export async function extractTextFromPDF(
  pdfBytes: ArrayBuffer
): Promise<TextLine[][]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const copy = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(copy).set(new Uint8Array(pdfBytes));

  const doc = await pdfjs.getDocument({ data: copy }).promise;
  const allPages: TextLine[][] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();

    const items = textContent.items
      .filter((item): item is typeof item & { str: string; transform: number[] } =>
        "transform" in item && item.transform !== undefined
      )
      .map((item) => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
      }));

    const lines = groupIntoLines(items);
    allPages.push(lines);

    page.cleanup();
  }

  return allPages;
}

function groupIntoLines(
  items: { text: string; x: number; y: number }[],
  threshold = 2
): TextLine[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => b.y - a.y);

  const lines: TextLine[] = [];
  let currentLine = sorted[0];
  let currentText = sorted[0].text;

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];

    if (Math.abs(item.y - currentLine.y) <= threshold) {
      currentText += " " + item.text;
    } else {
      lines.push({
        text: currentText.trim(),
        y: currentLine.y,
        x: currentLine.x,
      });
      currentLine = item;
      currentText = item.text;
    }
  }

  lines.push({
    text: currentText.trim(),
    y: currentLine.y,
    x: currentLine.x,
  });

  return lines;
}

export function getFullText(lines: TextLine[]): string {
  return lines.map((l) => l.text).join("\n");
}

export function findLineContaining(
  lines: TextLine[],
  search: string
): TextLine | undefined {
  return lines.find((l) => l.text.toLowerCase().includes(search.toLowerCase()));
}

export function findLineAfter(
  lines: TextLine[],
  search: string
): TextLine | undefined {
  const idx = lines.findIndex((l) =>
    l.text.toLowerCase().includes(search.toLowerCase())
  );
  if (idx === -1 || idx + 1 >= lines.length) return undefined;
  return lines[idx + 1];
}

export function extractAfterLabel(
  lines: TextLine[],
  label: string
): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const regex = new RegExp(`${escapedLabel}\\s*[:#\\-]?\\s*(.+)`, "i");
    const match = line.text.match(regex);
    const value = match?.[1]?.trim();
    if (value && !value.startsWith("|")) {
      return value;
    }

    const labelOnlyRegex = new RegExp(`^\\s*${escapedLabel}\\s*[:#\\-]?\\s*$`, "i");
    if (labelOnlyRegex.test(line.text)) {
      const nextLine = lines.slice(i + 1).find((l) => l.text.trim());
      if (nextLine) return nextLine.text.trim();
    }
  }
  return undefined;
}

export function extractQuantity(
  lines: TextLine[],
  labels = ["TOTAL QTY", "Total Qty", "Qty", "Quantity", "Ordered Qty"]
): number {
  for (const label of labels) {
    const value = extractAfterLabel(lines, label);
    const quantity = parseFirstPositiveInteger(value);
    if (quantity) return quantity;
  }

  for (const line of lines) {
    const match = line.text.match(
      /\b(?:total\s+qty|ordered\s+qty|qty|quantity)\b\D{0,20}(\d+)/i
    );
    const quantity = parseFirstPositiveInteger(match?.[1]);
    if (quantity) return quantity;
  }

  return 1;
}

function parseFirstPositiveInteger(value: string | undefined): number | null {
  const match = value?.match(/\b([1-9]\d*)\b/);
  return match ? Number(match[1]) : null;
}
