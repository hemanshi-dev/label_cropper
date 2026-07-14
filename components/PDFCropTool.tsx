"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";

import type { CropConfig } from "@/lib/crop-config";
import type { OrderData } from "@/lib/parsers/types";
import type { SortMode, FilterMode } from "./FilterOptions";

import { extractOrders } from "@/lib/parsers";
import { sortOrders } from "@/lib/parsers/sort";
import { filterOrders } from "@/lib/parsers/filter";
import { getPlatformId } from "@/lib/platforms";

interface PDFCropToolProps {
  config: CropConfig;
  printMode: "label" | "a4";
  platformName: string;
  invoiceMode: "with" | "without";
  sortMode: SortMode;
  filterMode: FilterMode;
  onOrdersExtracted: (orders: OrderData[]) => void;
}

interface PageData {
  index: number;
  width: number;
  height: number;
  dataUrl: string;
}

interface CropRegion {
  top: number;
  left: number;
  width: number;
  height: number;
}

type PdfJsModule = typeof import("pdfjs-dist");

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

const MM_TO_PT = 72 / 25.4;

/**
 * Exact physical thermal-label sizes.
 *
 * Amazon  : 100 mm × 150 mm
 * Flipkart:  75 mm × 125 mm
 * Meesho  : 100 mm × 150 mm
 */
const AMAZON_LABEL_WIDTH_PT = 100 * MM_TO_PT;
const AMAZON_LABEL_HEIGHT_PT = 150 * MM_TO_PT;

const FLIPKART_LABEL_WIDTH_PT = 75 * MM_TO_PT;
const FLIPKART_LABEL_HEIGHT_PT = 125 * MM_TO_PT;

const MEESHO_LABEL_WIDTH_PT = 100 * MM_TO_PT;
const MEESHO_LABEL_HEIGHT_PT = 150 * MM_TO_PT;

/**
 * A4 portrait is 210mm × 297mm.
 *
 * Four exact 100mm × 150mm labels need 200mm × 300mm, so they are
 * 3mm taller than A4. For Amazon and Meesho A4 four-up mode, only
 * the height is reduced by 1.5mm:
 *
 * 100mm × 148.5mm, arranged as 2 columns × 2 rows.
 *
 * Normal Labels (mm) output remains exactly 100mm × 150mm.
 */
const A4_FOUR_UP_100MM_WIDTH_PT = 100 * MM_TO_PT;
const A4_FOUR_UP_148_5MM_HEIGHT_PT = 148.5 * MM_TO_PT;

/**
 * Exact dimensions measured from the three reference PDFs.
 *
 * Amazon / Flipkart reference:
 * - A4 portrait page: 595.28 × 841.89 pt
 * - 2 × 2 slots
 * - each slot: 297.64 × 420.945 pt (105 × 148.5 mm)
 *
 * Meesho reference:
 * - custom landscape page: 1190.55 × 737.01 pt (420 × 260 mm)
 * - 2 × 2 slots
 * - each slot: 595.275 × 368.505 pt (210 × 130 mm)
 */
const REFERENCE_A4_CELL_WIDTH_PT = A4_WIDTH_PT / 2;
const REFERENCE_A4_CELL_HEIGHT_PT = A4_HEIGHT_PT / 2;

const MEESHO_REFERENCE_PAGE_WIDTH_PT = 420 * MM_TO_PT;
const MEESHO_REFERENCE_PAGE_HEIGHT_PT = 260 * MM_TO_PT;
const MEESHO_REFERENCE_CELL_WIDTH_PT =
  MEESHO_REFERENCE_PAGE_WIDTH_PT / 2;
const MEESHO_REFERENCE_CELL_HEIGHT_PT =
  MEESHO_REFERENCE_PAGE_HEIGHT_PT / 2;

const FULL_PAGE_REGION: CropRegion = {
  top: 0,
  left: 0,
  width: 100,
  height: 100,
};

function cloneArrayBuffer(source: ArrayBuffer): ArrayBuffer {
  const copy = new ArrayBuffer(source.byteLength);
  new Uint8Array(copy).set(new Uint8Array(source));
  return copy;
}

function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as any], {
    type: "application/pdf",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawImageContained(
  page: PDFPage,
  image: PDFImage,
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
): void {
  const scale = Math.min(
    box.width / image.width,
    box.height / image.height,
  );

  const width = image.width * scale;
  const height = image.height * scale;

  page.drawImage(image, {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  });
}

function shortenText(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  return `${value.slice(0, maximumLength - 3)}...`;
}

export default function PDFCropTool({
  config,
  printMode,
  platformName,
  invoiceMode,
  sortMode,
  filterMode,
  onOrdersExtracted,
}: PDFCropToolProps) {
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState<PageData[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [pdfjs, setPdfjs] = useState<PdfJsModule | null>(null);
  const [orders, setOrders] = useState<OrderData[]>([]);

  const getEffectiveCrop = useCallback((): CropRegion => {
    if (platformName === "Meesho" && invoiceMode === "with") {
      return {
        top: 1,
        left: 2,
        width: 97,
        height: 78.5,
      };
    }

    return config.region;
  }, [config.region, invoiceMode, platformName]);

  const [crop, setCrop] = useState<CropRegion>(() =>
    getEffectiveCrop(),
  );

  useEffect(() => {
    setCrop(getEffectiveCrop());
  }, [getEffectiveCrop]);

  useEffect(() => {
    let active = true;

    const loadPdfjs = async () => {
      try {
        const pdfJsModule = await import("pdfjs-dist");
        pdfJsModule.GlobalWorkerOptions.workerSrc =
          "/pdf.worker.min.mjs";

        if (active) {
          setPdfjs(pdfJsModule);
        }
      } catch (loadError) {
        console.error(loadError);

        if (active) {
          setError("Could not load the PDF engine.");
        }
      }
    };

    void loadPdfjs();

    return () => {
      active = false;
    };
  }, []);

  const isFlipkartWithInvoice =
    platformName === "Flipkart" && invoiceMode === "with";

  const isMeeshoWithInvoice =
    platformName === "Meesho" && invoiceMode === "with";

  const isAmazon = platformName === "Amazon";
  const isFlipkart = platformName === "Flipkart";
  const isMeesho = platformName === "Meesho";

  const renderPages = useCallback(
    async (bytes: ArrayBuffer): Promise<PageData[]> => {
      if (!pdfjs) return [];

      const doc = await pdfjs.getDocument({
        data: cloneArrayBuffer(bytes),
      }).promise;

      const newPages: PageData[] = [];

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        /*
         * Amazon original PDF:
         * odd PDF pages = labels
         * even PDF pages = invoices
         *
         * "Without Invoice" preview should show labels only.
         */
        if (
          platformName === "Amazon" &&
          invoiceMode === "without" &&
          pageNumber % 2 === 0
        ) {
          continue;
        }

        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.5 });

        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Canvas is not available.");
        }

        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvas,
          canvasContext: context,
          viewport,
        }).promise;

        newPages.push({
          index: pageNumber,
          width: viewport.width,
          height: viewport.height,
          dataUrl: canvas.toDataURL("image/png"),
        });
      }

      return newPages;
    },
    [invoiceMode, pdfjs, platformName],
  );

  useEffect(() => {
    let cancelled = false;

    const syncPages = async () => {
      if (!pdfBytes || !pdfjs) return;

      try {
        const nextPages = await renderPages(pdfBytes);

        if (!cancelled) {
          setPages(nextPages);
        }
      } catch (renderError) {
        console.error(renderError);

        if (!cancelled) {
          setError("Could not refresh the PDF preview.");
        }
      }
    };

    void syncPages();

    return () => {
      cancelled = true;
    };
  }, [invoiceMode, pdfBytes, pdfjs, renderPages]);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      setError(null);
      setPages([]);
      setFileName(null);
      setPdfBytes(null);
      setOrders([]);
      onOrdersExtracted([]);

      if (acceptedFiles.length === 0) return;

      if (!pdfjs) {
        setError("PDF engine is still loading. Please try again.");
        return;
      }

      const file = acceptedFiles[0];

      if (
        file.type !== "application/pdf" &&
        !file.name.toLowerCase().endsWith(".pdf")
      ) {
        setError("Please upload a PDF file.");
        return;
      }

      setFileName(file.name);

      try {
        const bytes = await file.arrayBuffer();

        const [renderedPages, extractedOrders] = await Promise.all([
          renderPages(bytes),
          (async () => {
            const platformId = getPlatformId(platformName);

            if (!platformId) {
              throw new Error(
                `Could not resolve platform: ${platformName}`,
              );
            }

            return extractOrders(bytes, platformId);
          })(),
        ]);

        console.log(
          "Extracted orders:",
          extractedOrders.map((order) => ({
            page: order.page,
            orderId: order.orderId,
            sku: order.sku,
            quantity: order.quantity,
            isMultiOrder: order.isMultiOrder,
          })),
        );

        setPdfBytes(bytes);
        setPages(renderedPages);
        setOrders(extractedOrders);
        onOrdersExtracted(extractedOrders);

        if (
          platformName === "Amazon" &&
          extractedOrders.length === 0
        ) {
          setError(
            "No Amazon invoice data was detected. Check the browser console for parser details.",
          );
        }
      } catch (dropError) {
        console.error(dropError);
        setError(
          dropError instanceof Error
            ? dropError.message
            : "Error reading PDF. Please try again.",
        );
      }
    },
    [onOrdersExtracted, pdfjs, platformName, renderPages],
  );

  const { getRootProps, getInputProps, isDragActive } =
    useDropzone({
      onDrop,
      accept: {
        "application/pdf": [".pdf"],
      },
      maxFiles: 1,
      multiple: false,
      disabled: processing || !pdfjs,
    });

  const getCropBox = (
    pageWidth: number,
    pageHeight: number,
  ) => {
    const widthRatio = crop.width / 100;
    const heightRatio = crop.height / 100;
    const topOffset = crop.top / 100;
    const leftOffset = crop.left / 100;

    return {
      x: pageWidth * leftOffset,
      y: pageHeight * (1 - topOffset - heightRatio),
      width: pageWidth * widthRatio,
      height: pageHeight * heightRatio,
    };
  };

  const getCropBoxFromRegion = (
    region: CropRegion,
    sourceDocument: PDFDocument,
    pageIndex: number,
  ) => {
    const page = sourceDocument.getPage(pageIndex);
    const { width: pageWidth, height: pageHeight } =
      page.getSize();

    const widthRatio = region.width / 100;
    const heightRatio = region.height / 100;
    const topOffset = region.top / 100;
    const leftOffset = region.left / 100;

    return {
      x: pageWidth * leftOffset,
      y: pageHeight * (1 - topOffset - heightRatio),
      width: pageWidth * widthRatio,
      height: pageHeight * heightRatio,
    };
  };

  const invoiceCrop = config.invoiceRegion;

  const renderCroppedPageToPng = async (
    sourceBytes: ArrayBuffer,
    pageIndex: number,
    cropRegion: CropRegion = crop,
  ): Promise<Uint8Array> => {
    if (!pdfjs) {
      throw new Error("PDF renderer is not ready.");
    }

    const scale = 2;

    const doc = await pdfjs.getDocument({
      data: cloneArrayBuffer(sourceBytes),
    }).promise;

    if (pageIndex < 0 || pageIndex >= doc.numPages) {
      throw new Error(
        `PDF page ${pageIndex + 1} does not exist.`,
      );
    }

    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Canvas is not available.");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;

    const cropX = Math.max(
      0,
      Math.floor((viewport.width * cropRegion.left) / 100),
    );

    const cropY = Math.max(
      0,
      Math.floor((viewport.height * cropRegion.top) / 100),
    );

    const cropWidth = Math.max(
      1,
      Math.min(
        canvas.width - cropX,
        Math.floor((viewport.width * cropRegion.width) / 100),
      ),
    );

    const cropHeight = Math.max(
      1,
      Math.min(
        canvas.height - cropY,
        Math.floor((viewport.height * cropRegion.height) / 100),
      ),
    );

    const croppedCanvas = document.createElement("canvas");
    croppedCanvas.width = cropWidth;
    croppedCanvas.height = cropHeight;

    const croppedContext = croppedCanvas.getContext("2d");

    if (!croppedContext) {
      throw new Error("Crop canvas is not available.");
    }

    croppedContext.fillStyle = "#ffffff";
    croppedContext.fillRect(
      0,
      0,
      croppedCanvas.width,
      croppedCanvas.height,
    );

    croppedContext.drawImage(
      canvas,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );

    const blob = await new Promise<Blob>((resolve, reject) => {
      croppedCanvas.toBlob((result) => {
        if (!result) {
          reject(new Error("Could not create cropped PDF image."));
          return;
        }

        resolve(result);
      }, "image/png");
    });

    return new Uint8Array(await blob.arrayBuffer());
  };

  const filteredAndSortedOrders = useMemo(() => {
    const filtered = filterOrders(orders, filterMode);
    return sortOrders(filtered, sortMode);
  }, [filterMode, orders, sortMode]);

  interface FixedLabelEntry {
    pageIndex: number;
    order: OrderData | null;
  }

  const getFixedLabelEntries = (
    selectedOrders: OrderData[],
    pageIndices: number[],
  ): FixedLabelEntry[] => {
    if (selectedOrders.length > 0) {
      return selectedOrders.map((order) => ({
        pageIndex: order.page - 1,
        order,
      }));
    }

    return pageIndices.map((pageIndex) => ({
      pageIndex,
      order: null,
    }));
  };

  /**
   * Creates one exact physical-size PDF page per shipping label.
   */
  const createExactLabelModePdf = async ({
    sourceBytes,
    selectedOrders,
    pageIndices,
    labelWidth,
    labelHeight,
    showSkuCaption,
  }: {
    sourceBytes: ArrayBuffer;
    selectedOrders: OrderData[];
    pageIndices: number[];
    labelWidth: number;
    labelHeight: number;
    showSkuCaption: boolean;
  }): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const entries = getFixedLabelEntries(
      selectedOrders,
      pageIndices,
    );

    const captionHeight = showSkuCaption ? 22 : 0;
    const padding = 5;

    for (
      let entryIndex = 0;
      entryIndex < entries.length;
      entryIndex += 1
    ) {
      const entry = entries[entryIndex];

      if (entry.pageIndex < 0) {
        throw new Error(
          `Label page ${entry.pageIndex + 1} is invalid.`,
        );
      }

      const labelPng = await renderCroppedPageToPng(
        sourceBytes,
        entry.pageIndex,
        crop,
      );

      const labelImage =
        await outputDocument.embedPng(labelPng);

      const outputPage = outputDocument.addPage([
        labelWidth,
        labelHeight,
      ]);

      drawImageContained(outputPage, labelImage, {
        x: padding,
        y: captionHeight + padding,
        width: labelWidth - padding * 2,
        height:
          labelHeight -
          captionHeight -
          padding * 2,
      });

      if (showSkuCaption && entry.order) {
        outputPage.drawText(
          shortenText(
            `${entry.order.sku} | Qty - ${entry.order.quantity}`,
            labelWidth <= FLIPKART_LABEL_WIDTH_PT + 1
              ? 32
              : 42,
          ),
          {
            x: padding + 1,
            y: 8,
            size: 7,
            font: boldFont,
          },
        );

        outputPage.drawText(
          `Order - ${entryIndex + 1}`,
          {
            x:
              labelWidth -
              (labelWidth <= FLIPKART_LABEL_WIDTH_PT + 1
                ? 55
                : 62),
            y: 8,
            size: 7,
            font: regularFont,
          },
        );
      }
    }

    return outputDocument.save();
  };

  /**
   * Places exact-size physical labels on a true A4 PDF page.
   *
   * Amazon/Meesho:
   *   4 labels per A4 page using 100mm × 148.5mm A4-fit boxes.
   *   Their standalone Labels (mm) pages remain exactly 100mm × 150mm.
   *
   * Flipkart 75x125:
   *   4 exact-size labels per A4 page (2 columns × 2 rows).
   */
  const createExactA4LabelPdf = async ({
    sourceBytes,
    selectedOrders,
    pageIndices,
    labelWidth,
    labelHeight,
    columns,
    rows,
    horizontalGapMm,
    verticalGapMm,
    showSkuCaption,
  }: {
    sourceBytes: ArrayBuffer;
    selectedOrders: OrderData[];
    pageIndices: number[];
    labelWidth: number;
    labelHeight: number;
    columns: number;
    rows: number;
    horizontalGapMm: number;
    verticalGapMm: number;
    showSkuCaption: boolean;
  }): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const entries = getFixedLabelEntries(
      selectedOrders,
      pageIndices,
    );

    const labelsPerPage = columns * rows;

    const horizontalGap =
      horizontalGapMm * MM_TO_PT;

    const verticalGap =
      verticalGapMm * MM_TO_PT;

    const gridWidth =
      columns * labelWidth +
      Math.max(0, columns - 1) * horizontalGap;

    const gridHeight =
      rows * labelHeight +
      Math.max(0, rows - 1) * verticalGap;

    if (
      gridWidth > A4_WIDTH_PT ||
      gridHeight > A4_HEIGHT_PT
    ) {
      throw new Error(
        "The selected physical label layout does not fit on A4.",
      );
    }

    const gridStartX =
      (A4_WIDTH_PT - gridWidth) / 2;

    const gridStartY =
      (A4_HEIGHT_PT - gridHeight) / 2;

    const captionHeight = showSkuCaption ? 22 : 0;
    const padding = 5;

    for (
      let entryStart = 0;
      entryStart < entries.length;
      entryStart += labelsPerPage
    ) {
      const outputPage = outputDocument.addPage([
        A4_WIDTH_PT,
        A4_HEIGHT_PT,
      ]);

      const batch = entries.slice(
        entryStart,
        entryStart + labelsPerPage,
      );

      for (
        let position = 0;
        position < batch.length;
        position += 1
      ) {
        const entry = batch[position];

        if (entry.pageIndex < 0) {
          throw new Error(
            `Label page ${entry.pageIndex + 1} is invalid.`,
          );
        }

        const labelPng = await renderCroppedPageToPng(
          sourceBytes,
          entry.pageIndex,
          crop,
        );

        const labelImage =
          await outputDocument.embedPng(labelPng);

        const column = position % columns;
        const row = Math.floor(position / columns);

        const labelX =
          gridStartX +
          column * (labelWidth + horizontalGap);

        const labelY =
          A4_HEIGHT_PT -
          gridStartY -
          (row + 1) * labelHeight -
          row * verticalGap;

        /*
         * Image and caption stay inside the exact physical label box.
         */
        drawImageContained(outputPage, labelImage, {
          x: labelX + padding,
          y: labelY + captionHeight + padding,
          width: labelWidth - padding * 2,
          height:
            labelHeight -
            captionHeight -
            padding * 2,
        });

        if (showSkuCaption && entry.order) {
          const displayOrderNumber =
            entryStart + position + 1;

          outputPage.drawText(
            shortenText(
              `${entry.order.sku} | Qty - ${entry.order.quantity}`,
              labelWidth <= FLIPKART_LABEL_WIDTH_PT + 1
                ? 32
                : 42,
            ),
            {
              x: labelX + padding + 1,
              y: labelY + 8,
              size: 7,
              font: boldFont,
            },
          );

          outputPage.drawText(
            `Order - ${displayOrderNumber}`,
            {
              x:
                labelX +
                labelWidth -
                (labelWidth <=
                FLIPKART_LABEL_WIDTH_PT + 1
                  ? 55
                  : 62),
              y: labelY + 8,
              size: 7,
              font: regularFont,
            },
          );
        }
      }
    }

    return outputDocument.save();
  };

  /**
   * Builds the exact Amazon label layout shown in amazonlabel_demo.pdf.
   *
   * A4 mode:
   * - true A4 portrait page
   * - maximum 4 labels
   * - 2 columns × 2 rows
   *
   * Label mode:
   * - one 105mm × 148.5mm page per label
   *
   * The SKU strip uses the exact measured position from the reference.
   */
  const createAmazonReferenceLabels = async (
    sourceBytes: ArrayBuffer,
    selectedOrders: OrderData[],
    pageIndices: number[],
    outputMode: "label" | "a4",
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const entries = getFixedLabelEntries(
      selectedOrders,
      pageIndices,
    );

    const columns = outputMode === "a4" ? 2 : 1;
    const rows = outputMode === "a4" ? 2 : 1;
    const labelsPerPage = columns * rows;

    const pageWidth =
      outputMode === "a4"
        ? A4_WIDTH_PT
        : REFERENCE_A4_CELL_WIDTH_PT;

    const pageHeight =
      outputMode === "a4"
        ? A4_HEIGHT_PT
        : REFERENCE_A4_CELL_HEIGHT_PT;

    /*
     * Exact values measured from amazonlabel_demo.pdf.
     * Coordinates below are relative to one 105mm × 148.5mm slot.
     */
    const imageLeft = 18.0848;
    const imageTop = 18.0257;
    const imageWidth = 273.5453;
    const imageHeight = 410.3179;

    const skuBoxLeft = 5.67;
    const skuBoxTop = 334.49;
    const skuBoxWidth = 286.3;
    const skuBoxHeight = 21.26;

    for (
      let entryStart = 0;
      entryStart < entries.length;
      entryStart += labelsPerPage
    ) {
      const outputPage = outputDocument.addPage([
        pageWidth,
        pageHeight,
      ]);

      const batch = entries.slice(
        entryStart,
        entryStart + labelsPerPage,
      );

      for (
        let position = 0;
        position < batch.length;
        position += 1
      ) {
        const entry = batch[position];
        const column = position % columns;
        const row = Math.floor(position / columns);

        const slotX =
          column * REFERENCE_A4_CELL_WIDTH_PT;

        const slotTop =
          row * REFERENCE_A4_CELL_HEIGHT_PT;

        const slotBottom =
          pageHeight -
          slotTop -
          REFERENCE_A4_CELL_HEIGHT_PT;

        const labelPng = await renderCroppedPageToPng(
          sourceBytes,
          entry.pageIndex,
          crop,
        );

        const labelImage =
          await outputDocument.embedPng(labelPng);

        /*
         * This intentionally matches the reference transform, including
         * the small white-image overhang below the slot.
         */
        outputPage.drawImage(labelImage, {
          x: slotX + imageLeft,
          y:
            pageHeight -
            slotTop -
            imageTop -
            imageHeight,
          width: imageWidth,
          height: imageHeight,
        });

        if (entry.order) {
          const skuBoxY =
            pageHeight -
            slotTop -
            skuBoxTop -
            skuBoxHeight;

          outputPage.drawRectangle({
            x: slotX + skuBoxLeft,
            y: skuBoxY,
            width: skuBoxWidth,
            height: skuBoxHeight,
            color: rgb(1, 1, 1),
            borderColor: rgb(0, 0, 0),
            borderWidth: 0.57,
          });

          outputPage.drawText(
            shortenText(
              `${entry.order.sku} - ${entry.order.quantity} Qty`,
              68,
            ),
            {
              x: slotX + 11.34,
              y: skuBoxY + 9.2,
              size: 4.5,
              font: boldFont,
            },
          );
        }

        outputPage.drawRectangle({
          x: slotX,
          y: slotBottom,
          width: REFERENCE_A4_CELL_WIDTH_PT,
          height: REFERENCE_A4_CELL_HEIGHT_PT,
          borderColor: rgb(0.784, 0.784, 0.784),
          borderWidth: 0.28,
        });
      }
    }

    return outputDocument.save();
  };

  /**
   * Builds the exact Flipkart layout shown in flipcrtlabel_demo.pdf.
   *
   * A4 mode:
   * - true A4 portrait page
   * - maximum 4 labels
   * - 2 columns × 2 rows
   *
   * Label mode:
   * - one 105mm × 148.5mm page per label
   */
  const createFlipkartReferenceLabels = async (
    sourceBytes: ArrayBuffer,
    selectedOrders: OrderData[],
    pageIndices: number[],
    outputMode: "label" | "a4",
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const entries = getFixedLabelEntries(
      selectedOrders,
      pageIndices,
    );

    const columns = outputMode === "a4" ? 2 : 1;
    const rows = outputMode === "a4" ? 2 : 1;
    const labelsPerPage = columns * rows;

    const pageWidth =
      outputMode === "a4"
        ? A4_WIDTH_PT
        : REFERENCE_A4_CELL_WIDTH_PT;

    const pageHeight =
      outputMode === "a4"
        ? A4_HEIGHT_PT
        : REFERENCE_A4_CELL_HEIGHT_PT;

    /*
     * Exact image placement measured from flipcrtlabel_demo.pdf.
     */
    const imageLeft = 8.5;
    const imageTop = 0.01;
    const imageWidth = 280.63;
    const imageHeight = 420.94;

    for (
      let entryStart = 0;
      entryStart < entries.length;
      entryStart += labelsPerPage
    ) {
      const outputPage = outputDocument.addPage([
        pageWidth,
        pageHeight,
      ]);

      const batch = entries.slice(
        entryStart,
        entryStart + labelsPerPage,
      );

      for (
        let position = 0;
        position < batch.length;
        position += 1
      ) {
        const entry = batch[position];
        const column = position % columns;
        const row = Math.floor(position / columns);

        const slotX =
          column * REFERENCE_A4_CELL_WIDTH_PT;

        const slotTop =
          row * REFERENCE_A4_CELL_HEIGHT_PT;

        const labelPng = await renderCroppedPageToPng(
          sourceBytes,
          entry.pageIndex,
          crop,
        );

        const labelImage =
          await outputDocument.embedPng(labelPng);

        outputPage.drawImage(labelImage, {
          x: slotX + imageLeft,
          y:
            pageHeight -
            slotTop -
            imageTop -
            imageHeight,
          width: imageWidth,
          height: imageHeight,
        });
      }

      if (outputMode === "a4") {
        outputPage.drawLine({
          start: {
            x: REFERENCE_A4_CELL_WIDTH_PT,
            y: 0,
          },
          end: {
            x: REFERENCE_A4_CELL_WIDTH_PT,
            y: A4_HEIGHT_PT,
          },
          thickness: 0.57,
          color: rgb(0.784, 0.784, 0.784),
        });

        outputPage.drawLine({
          start: {
            x: 0,
            y: REFERENCE_A4_CELL_HEIGHT_PT,
          },
          end: {
            x: A4_WIDTH_PT,
            y: REFERENCE_A4_CELL_HEIGHT_PT,
          },
          thickness: 0.57,
          color: rgb(0.784, 0.784, 0.784),
        });
      }
    }

    return outputDocument.save();
  };

  /**
   * Builds the exact Meesho page/cell dimensions measured from
   * meesholabel_demo.pdf.
   *
   * A4 button output intentionally follows the supplied reference:
   * - custom landscape page: 420mm × 260mm
   * - maximum 4 labels
   * - 2 columns × 2 rows
   * - each label slot: 210mm × 130mm
   *
   * Label mode:
   * - one 210mm × 130mm page per label
   */
  const createMeeshoReferenceLabels = async (
    sourceBytes: ArrayBuffer,
    selectedOrders: OrderData[],
    pageIndices: number[],
    outputMode: "label" | "a4",
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const entries = getFixedLabelEntries(
      selectedOrders,
      pageIndices,
    );

    const columns = outputMode === "a4" ? 2 : 1;
    const rows = outputMode === "a4" ? 2 : 1;
    const labelsPerPage = columns * rows;

    const pageWidth =
      outputMode === "a4"
        ? MEESHO_REFERENCE_PAGE_WIDTH_PT
        : MEESHO_REFERENCE_CELL_WIDTH_PT;

    const pageHeight =
      outputMode === "a4"
        ? MEESHO_REFERENCE_PAGE_HEIGHT_PT
        : MEESHO_REFERENCE_CELL_HEIGHT_PT;

    for (
      let entryStart = 0;
      entryStart < entries.length;
      entryStart += labelsPerPage
    ) {
      const outputPage = outputDocument.addPage([
        pageWidth,
        pageHeight,
      ]);

      const batch = entries.slice(
        entryStart,
        entryStart + labelsPerPage,
      );

      for (
        let position = 0;
        position < batch.length;
        position += 1
      ) {
        const entry = batch[position];
        const column = position % columns;
        const row = Math.floor(position / columns);

        const slotX =
          column * MEESHO_REFERENCE_CELL_WIDTH_PT;

        const slotBottom =
          pageHeight -
          (row + 1) *
            MEESHO_REFERENCE_CELL_HEIGHT_PT;

        const labelPng = await renderCroppedPageToPng(
          sourceBytes,
          entry.pageIndex,
          crop,
        );

        const labelImage =
          await outputDocument.embedPng(labelPng);

        /*
         * The supplied Meesho reference uses one full 210mm × 130mm
         * label surface per slot.
         */
        drawImageContained(outputPage, labelImage, {
          x: slotX,
          y: slotBottom,
          width: MEESHO_REFERENCE_CELL_WIDTH_PT,
          height: MEESHO_REFERENCE_CELL_HEIGHT_PT,
        });
      }
    }

    return outputDocument.save();
  };

  const createAmazonA4WithInvoices = async (
    sourceBytes: ArrayBuffer,
    sourceDocument: PDFDocument,
    selectedOrders: OrderData[],
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const rowHeight = A4_HEIGHT_PT / 2;
    const columnWidth = A4_WIDTH_PT / 2;
    const captionHeight = 20;
    const padding = 6;

    for (
      let orderStart = 0;
      orderStart < selectedOrders.length;
      orderStart += 2
    ) {
      const outputPage = outputDocument.addPage([
        A4_WIDTH_PT,
        A4_HEIGHT_PT,
      ]);

      const batch = selectedOrders.slice(
        orderStart,
        orderStart + 2,
      );

      for (let slot = 0; slot < batch.length; slot += 1) {
        const order = batch[slot];

        /*
         * order.page is the one-based shipping-label page.
         * The matching invoice is the immediately following page.
         */
        const labelPageIndex = order.page - 1;
        const invoicePageIndex = labelPageIndex + 1;

        if (
          labelPageIndex < 0 ||
          invoicePageIndex >= sourceDocument.getPageCount()
        ) {
          throw new Error(
            `Invoice pair is missing for Amazon order ${order.orderId}.`,
          );
        }

        const [labelPng, invoicePng] = await Promise.all([
          renderCroppedPageToPng(
            sourceBytes,
            labelPageIndex,
            crop,
          ),
          renderCroppedPageToPng(
            sourceBytes,
            invoicePageIndex,
            FULL_PAGE_REGION,
          ),
        ]);

        const [labelImage, invoiceImage] = await Promise.all([
          outputDocument.embedPng(labelPng),
          outputDocument.embedPng(invoicePng),
        ]);

        const rowBottom =
          A4_HEIGHT_PT - (slot + 1) * rowHeight;

        const contentY =
          rowBottom + captionHeight + padding;

        const contentHeight =
          rowHeight - captionHeight - padding * 2;

        drawImageContained(outputPage, labelImage, {
          x: padding,
          y: contentY,
          width: columnWidth - padding * 2,
          height: contentHeight,
        });

        drawImageContained(outputPage, invoiceImage, {
          x: columnWidth + padding,
          y: contentY,
          width: columnWidth - padding * 2,
          height: contentHeight,
        });

        const displayOrderNumber = orderStart + slot + 1;

        outputPage.drawText(
          shortenText(
            `${order.sku} | Qty - ${order.quantity}`,
            48,
          ),
          {
            x: padding + 2,
            y: rowBottom + 7,
            size: 7,
            font: boldFont,
          },
        );

        const orderCaption = `Order - ${displayOrderNumber}`;

        outputPage.drawText(orderCaption, {
          x: columnWidth - 58,
          y: rowBottom + 7,
          size: 7,
          font: regularFont,
        });

        outputPage.drawText(orderCaption, {
          x: A4_WIDTH_PT - 58,
          y: rowBottom + 7,
          size: 7,
          font: regularFont,
        });
      }
    }

    return outputDocument.save();
  };

  /**
   * Amazon WITH invoice, label/mm mode:
   *
   * Output sequence:
   * 1. Cropped label page with SKU + Qty caption
   * 2. Matching full invoice page
   */
  const createAmazonLabelModeWithInvoices = async (
    sourceBytes: ArrayBuffer,
    sourceDocument: PDFDocument,
    selectedOrders: OrderData[],
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const labelWidth = AMAZON_LABEL_WIDTH_PT;
    const labelHeight = AMAZON_LABEL_HEIGHT_PT;
    const captionHeight = 22;
    const padding = 6;

    for (
      let orderIndex = 0;
      orderIndex < selectedOrders.length;
      orderIndex += 1
    ) {
      const order = selectedOrders[orderIndex];

      const labelPageIndex = order.page - 1;
      const invoicePageIndex = labelPageIndex + 1;

      if (
        labelPageIndex < 0 ||
        invoicePageIndex >= sourceDocument.getPageCount()
      ) {
        throw new Error(
          `Invoice pair is missing for Amazon order ${order.orderId}.`,
        );
      }

      /*
       * Render the cropped shipping label as an image so we can reserve
       * space at the bottom for SKU and quantity.
       */
      const labelPng = await renderCroppedPageToPng(
        sourceBytes,
        labelPageIndex,
        crop,
      );

      const labelImage =
        await outputDocument.embedPng(labelPng);

      const labelOutputPage = outputDocument.addPage([
        labelWidth,
        labelHeight,
      ]);

      drawImageContained(labelOutputPage, labelImage, {
        x: padding,
        y: captionHeight + padding,
        width: labelWidth - padding * 2,
        height:
          labelHeight -
          captionHeight -
          padding * 2,
      });

      labelOutputPage.drawText(
        shortenText(
          `${order.sku} | Qty - ${order.quantity}`,
          42,
        ),
        {
          x: padding + 2,
          y: 8,
          size: 8,
          font: boldFont,
        },
      );

      labelOutputPage.drawText(
        `Order - ${orderIndex + 1}`,
        {
          x: labelWidth - 62,
          y: 8,
          size: 8,
          font: regularFont,
        },
      );

      /*
       * Add the matching complete invoice immediately after its label.
       */
      const [invoicePage] =
        await outputDocument.copyPages(
          sourceDocument,
          [invoicePageIndex],
        );

      outputDocument.addPage(invoicePage);
    }

    return outputDocument.save();
  };

  /**
   * Amazon WITHOUT invoice, A4 mode:
   *
   * 4 labels per A4 page (2 columns x 2 rows).
   * Every label gets its SKU and quantity caption.
   */
  const createAmazonA4WithoutInvoices = async (
    sourceBytes: ArrayBuffer,
    selectedOrders: OrderData[],
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const columns = 2;
    const rows = 2;
    const labelsPerPage = columns * rows;

    const cellWidth = A4_WIDTH_PT / columns;
    const cellHeight = A4_HEIGHT_PT / rows;

    const captionHeight = 22;
    const padding = 6;

    for (
      let orderStart = 0;
      orderStart < selectedOrders.length;
      orderStart += labelsPerPage
    ) {
      const outputPage = outputDocument.addPage([
        A4_WIDTH_PT,
        A4_HEIGHT_PT,
      ]);

      const batch = selectedOrders.slice(
        orderStart,
        orderStart + labelsPerPage,
      );

      for (
        let position = 0;
        position < batch.length;
        position += 1
      ) {
        const order = batch[position];
        const labelPageIndex = order.page - 1;

        if (labelPageIndex < 0) {
          throw new Error(
            `Label page is missing for Amazon order ${order.orderId}.`,
          );
        }

        const labelPng = await renderCroppedPageToPng(
          sourceBytes,
          labelPageIndex,
          crop,
        );

        const labelImage =
          await outputDocument.embedPng(labelPng);

        const column = position % columns;
        const row = Math.floor(position / columns);

        const cellX = column * cellWidth;
        const cellBottom =
          A4_HEIGHT_PT - (row + 1) * cellHeight;

        drawImageContained(outputPage, labelImage, {
          x: cellX + padding,
          y: cellBottom + captionHeight + padding,
          width: cellWidth - padding * 2,
          height:
            cellHeight -
            captionHeight -
            padding * 2,
        });

        const displayOrderNumber =
          orderStart + position + 1;

        outputPage.drawText(
          shortenText(
            `${order.sku} | Qty - ${order.quantity}`,
            42,
          ),
          {
            x: cellX + padding + 2,
            y: cellBottom + 8,
            size: 7,
            font: boldFont,
          },
        );

        outputPage.drawText(
          `Order - ${displayOrderNumber}`,
          {
            x: cellX + cellWidth - 58,
            y: cellBottom + 8,
            size: 7,
            font: regularFont,
          },
        );
      }
    }

    return outputDocument.save();
  };

  /**
   * Amazon WITHOUT invoice, label/mm mode:
   *
   * One 100 mm x 150 mm output page per label.
   * SKU and quantity are printed at the bottom of every page.
   */
  const createAmazonLabelModeWithoutInvoices = async (
    sourceBytes: ArrayBuffer,
    selectedOrders: OrderData[],
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const labelWidth = AMAZON_LABEL_WIDTH_PT;
    const labelHeight = AMAZON_LABEL_HEIGHT_PT;
    const captionHeight = 22;
    const padding = 6;

    for (
      let orderIndex = 0;
      orderIndex < selectedOrders.length;
      orderIndex += 1
    ) {
      const order = selectedOrders[orderIndex];
      const labelPageIndex = order.page - 1;

      if (labelPageIndex < 0) {
        throw new Error(
          `Label page is missing for Amazon order ${order.orderId}.`,
        );
      }

      const labelPng = await renderCroppedPageToPng(
        sourceBytes,
        labelPageIndex,
        crop,
      );

      const labelImage =
        await outputDocument.embedPng(labelPng);

      const outputPage = outputDocument.addPage([
        labelWidth,
        labelHeight,
      ]);

      drawImageContained(outputPage, labelImage, {
        x: padding,
        y: captionHeight + padding,
        width: labelWidth - padding * 2,
        height:
          labelHeight -
          captionHeight -
          padding * 2,
      });

      outputPage.drawText(
        shortenText(
          `${order.sku} | Qty - ${order.quantity}`,
          42,
        ),
        {
          x: padding + 2,
          y: 8,
          size: 8,
          font: boldFont,
        },
      );

      outputPage.drawText(
        `Order - ${orderIndex + 1}`,
        {
          x: labelWidth - 62,
          y: 8,
          size: 8,
          font: regularFont,
        },
      );
    }

    return outputDocument.save();
  };

  /**
   * Flipkart WITH invoice, A4 mode.
   *
   * Each source page contains both the shipping label and invoice.
   * The output keeps one order per A4 page and adds SKU + Qty between
   * the label and invoice.
   */
  const createFlipkartA4WithInvoices = async (
    sourceBytes: ArrayBuffer,
    selectedOrders: OrderData[],
  ): Promise<Uint8Array> => {
    if (!invoiceCrop) {
      throw new Error(
        "Flipkart invoice crop region is not configured.",
      );
    }

    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const margin = 8;
    const captionHeight = 22;
    const gap = 5;

    const contentHeight =
      A4_HEIGHT_PT -
      margin * 2 -
      captionHeight -
      gap;

    const labelAreaHeight = contentHeight * 0.42;
    const invoiceAreaHeight =
      contentHeight - labelAreaHeight;

    for (
      let orderIndex = 0;
      orderIndex < selectedOrders.length;
      orderIndex += 1
    ) {
      const order = selectedOrders[orderIndex];
      const pageIndex = order.page - 1;

      const [labelPng, invoicePng] = await Promise.all([
        renderCroppedPageToPng(
          sourceBytes,
          pageIndex,
          crop,
        ),
        renderCroppedPageToPng(
          sourceBytes,
          pageIndex,
          invoiceCrop,
        ),
      ]);

      const [labelImage, invoiceImage] =
        await Promise.all([
          outputDocument.embedPng(labelPng),
          outputDocument.embedPng(invoicePng),
        ]);

      const outputPage = outputDocument.addPage([
        A4_WIDTH_PT,
        A4_HEIGHT_PT,
      ]);

      drawImageContained(outputPage, invoiceImage, {
        x: margin,
        y: margin,
        width: A4_WIDTH_PT - margin * 2,
        height: invoiceAreaHeight,
      });

      const captionY =
        margin + invoiceAreaHeight + 7;

      outputPage.drawText(
        shortenText(
          `${order.sku} | Qty - ${order.quantity}`,
          65,
        ),
        {
          x: margin + 3,
          y: captionY,
          size: 8,
          font: boldFont,
        },
      );

      outputPage.drawText(
        `Order - ${orderIndex + 1}`,
        {
          x: A4_WIDTH_PT - 67,
          y: captionY,
          size: 8,
          font: regularFont,
        },
      );

      drawImageContained(outputPage, labelImage, {
        x: margin,
        y:
          margin +
          invoiceAreaHeight +
          captionHeight +
          gap,
        width: A4_WIDTH_PT - margin * 2,
        height: labelAreaHeight,
      });
    }

    return outputDocument.save();
  };

  /**
   * Flipkart WITH invoice, label/mm mode.
   *
   * Output sequence:
   * 1. 100mm x 150mm label page with SKU + Qty
   * 2. Matching cropped invoice page
   */
  const createFlipkartLabelModeWithInvoices = async (
    sourceBytes: ArrayBuffer,
    sourceDocument: PDFDocument,
    selectedOrders: OrderData[],
  ): Promise<Uint8Array> => {
    if (!invoiceCrop) {
      throw new Error(
        "Flipkart invoice crop region is not configured.",
      );
    }

    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    /*
     * Exact Flipkart label page size: 75mm × 125mm.
     * SKU/Qty caption is kept inside this fixed-size page.
     */
    const labelWidth = FLIPKART_LABEL_WIDTH_PT;
    const labelHeight = FLIPKART_LABEL_HEIGHT_PT;
    const captionHeight = 20;
    const padding = 5;

    for (
      let orderIndex = 0;
      orderIndex < selectedOrders.length;
      orderIndex += 1
    ) {
      const order = selectedOrders[orderIndex];
      const pageIndex = order.page - 1;

      const labelPng = await renderCroppedPageToPng(
        sourceBytes,
        pageIndex,
        crop,
      );

      const labelImage =
        await outputDocument.embedPng(labelPng);

      const labelPage = outputDocument.addPage([
        labelWidth,
        labelHeight,
      ]);

      drawImageContained(labelPage, labelImage, {
        x: padding,
        y: captionHeight + padding,
        width: labelWidth - padding * 2,
        height:
          labelHeight -
          captionHeight -
          padding * 2,
      });

      labelPage.drawText(
        shortenText(
          `${order.sku} | Qty - ${order.quantity}`,
          32,
        ),
        {
          x: padding + 1,
          y: 7,
          size: 7,
          font: boldFont,
        },
      );

      labelPage.drawText(
        `Order - ${orderIndex + 1}`,
        {
          x: labelWidth - 55,
          y: 7,
          size: 7,
          font: regularFont,
        },
      );

      /*
       * Add the matching cropped invoice immediately after its
       * fixed-size 75mm × 125mm label page.
       */
      const invoiceBox = getCropBoxFromRegion(
        invoiceCrop,
        sourceDocument,
        pageIndex,
      );

      const [invoicePage] =
        await outputDocument.copyPages(
          sourceDocument,
          [pageIndex],
        );

      invoicePage.setMediaBox(
        invoiceBox.x,
        invoiceBox.y,
        invoiceBox.width,
        invoiceBox.height,
      );

      outputDocument.addPage(invoicePage);
    }

    return outputDocument.save();
  };

  /**
   * Flipkart WITHOUT invoice, A4 mode.
   *
   * Four labels are placed on one A4 page in a 2 x 2 grid.
   * SKU and quantity are printed under every label.
   */
  const createFlipkartA4WithoutInvoices = async (
    sourceBytes: ArrayBuffer,
    selectedOrders: OrderData[],
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    const columns = 2;
    const rows = 2;
    const labelsPerPage = columns * rows;

    /*
     * Each label remains exactly 75mm × 125mm on the A4 sheet.
     * Four labels fit as a centered 2 × 2 grid.
     */
    const labelWidth = FLIPKART_LABEL_WIDTH_PT;
    const labelHeight = FLIPKART_LABEL_HEIGHT_PT;

    const horizontalGap = 10 * MM_TO_PT;
    const verticalGap = 10 * MM_TO_PT;

    const gridWidth =
      columns * labelWidth +
      (columns - 1) * horizontalGap;

    const gridHeight =
      rows * labelHeight +
      (rows - 1) * verticalGap;

    const gridStartX =
      (A4_WIDTH_PT - gridWidth) / 2;

    const gridStartY =
      (A4_HEIGHT_PT - gridHeight) / 2;

    const captionHeight = 20;
    const padding = 5;

    for (
      let orderStart = 0;
      orderStart < selectedOrders.length;
      orderStart += labelsPerPage
    ) {
      const outputPage = outputDocument.addPage([
        A4_WIDTH_PT,
        A4_HEIGHT_PT,
      ]);

      const batch = selectedOrders.slice(
        orderStart,
        orderStart + labelsPerPage,
      );

      for (
        let position = 0;
        position < batch.length;
        position += 1
      ) {
        const order = batch[position];
        const pageIndex = order.page - 1;

        if (pageIndex < 0) {
          throw new Error(
            `Label page is missing for Flipkart order ${order.orderId}.`,
          );
        }

        const labelPng = await renderCroppedPageToPng(
          sourceBytes,
          pageIndex,
          crop,
        );

        const labelImage =
          await outputDocument.embedPng(labelPng);

        const column = position % columns;
        const row = Math.floor(position / columns);

        const labelX =
          gridStartX +
          column * (labelWidth + horizontalGap);

        const labelY =
          A4_HEIGHT_PT -
          gridStartY -
          (row + 1) * labelHeight -
          row * verticalGap;

        /*
         * The image and caption stay inside the exact 75mm × 125mm
         * physical label area.
         */
        drawImageContained(outputPage, labelImage, {
          x: labelX + padding,
          y: labelY + captionHeight + padding,
          width: labelWidth - padding * 2,
          height:
            labelHeight -
            captionHeight -
            padding * 2,
        });

        const displayOrderNumber =
          orderStart + position + 1;

        outputPage.drawText(
          shortenText(
            `${order.sku} | Qty - ${order.quantity}`,
            32,
          ),
          {
            x: labelX + padding + 1,
            y: labelY + 7,
            size: 7,
            font: boldFont,
          },
        );

        outputPage.drawText(
          `Order - ${displayOrderNumber}`,
          {
            x: labelX + labelWidth - 55,
            y: labelY + 7,
            size: 7,
            font: regularFont,
          },
        );
      }
    }

    return outputDocument.save();
  };

  /**
   * Flipkart WITHOUT invoice, label/mm mode.
   *
   * A4 is disabled in page.tsx for this mode.
   * Every label still displays SKU + Qty and respects the selected filter.
   */
  const createFlipkartLabelModeWithoutInvoices = async (
    sourceBytes: ArrayBuffer,
    selectedOrders: OrderData[],
  ): Promise<Uint8Array> => {
    const outputDocument = await PDFDocument.create();

    const regularFont = await outputDocument.embedFont(
      StandardFonts.Helvetica,
    );

    const boldFont = await outputDocument.embedFont(
      StandardFonts.HelveticaBold,
    );

    /*
     * Exact Flipkart thermal-label page size: 75mm × 125mm.
     */
    const labelWidth = FLIPKART_LABEL_WIDTH_PT;
    const labelHeight = FLIPKART_LABEL_HEIGHT_PT;
    const captionHeight = 20;
    const padding = 5;

    for (
      let orderIndex = 0;
      orderIndex < selectedOrders.length;
      orderIndex += 1
    ) {
      const order = selectedOrders[orderIndex];
      const pageIndex = order.page - 1;

      const labelPng = await renderCroppedPageToPng(
        sourceBytes,
        pageIndex,
        crop,
      );

      const labelImage =
        await outputDocument.embedPng(labelPng);

      const outputPage = outputDocument.addPage([
        labelWidth,
        labelHeight,
      ]);

      drawImageContained(outputPage, labelImage, {
        x: padding,
        y: captionHeight + padding,
        width: labelWidth - padding * 2,
        height:
          labelHeight -
          captionHeight -
          padding * 2,
      });

      outputPage.drawText(
        shortenText(
          `${order.sku} | Qty - ${order.quantity}`,
          32,
        ),
        {
          x: padding + 1,
          y: 7,
          size: 7,
          font: boldFont,
        },
      );

      outputPage.drawText(
        `Order - ${orderIndex + 1}`,
        {
          x: labelWidth - 55,
          y: 7,
          size: 7,
          font: regularFont,
        },
      );
    }

    return outputDocument.save();
  };

  const handleDownload = async () => {
    if (!pdfBytes || pages.length === 0) return;

    setProcessing(true);
    setError(null);

    try {
      const sourceDocument = await PDFDocument.load(
        cloneArrayBuffer(pdfBytes),
      );

      let sourcePageIndices = sourceDocument.getPageIndices();

      if (isAmazon && invoiceMode === "without") {
        sourcePageIndices = sourcePageIndices.filter(
          (pageIndex) => pageIndex % 2 === 0,
        );
      }

      if (isAmazon && orders.length === 0) {
        throw new Error(
          "Amazon order data was not detected. OCR is not required for this PDF; verify that amazon.ts is replaced with the updated parser.",
        );
      }

      if (isFlipkart && orders.length === 0) {
        throw new Error(
          "Flipkart order data was not detected. Verify that flipkart.ts is replaced with the updated parser.",
        );
      }

      if (orders.length === 0 && filterMode !== "all") {
        throw new Error(
          "Could not detect single/multi order details. Use All Orders or verify the parser output.",
        );
      }

      const selectedOrders = filteredAndSortedOrders;

      if (
        filterMode !== "all" &&
        selectedOrders.length === 0
      ) {
        throw new Error(
          `No ${
            filterMode === "single" ? "single" : "multi"
          } orders were detected in this PDF.`,
        );
      }

      const sortedLabelPageIndices = selectedOrders.map(
        (order) => order.page - 1,
      );

      const finalIndices =
        selectedOrders.length > 0
          ? sortedLabelPageIndices
          : sourcePageIndices;

      console.log("Download selection:", {
        invoiceMode,
        printMode,
        filterMode,
        sortMode,
        selectedOrders: selectedOrders.map((order) => ({
          orderId: order.orderId,
          sku: order.sku,
          quantity: order.quantity,
          page: order.page,
          isMultiOrder: order.isMultiOrder,
        })),
        finalIndices,
      });

      /*
       * AMAZON + WITH INVOICE
       *
       * This must run before the generic A4 branch. Otherwise the app
       * creates a 2x2 label-only page, which was the reported issue.
       */
      if (isAmazon && invoiceMode === "with") {
        const outputBytes =
          printMode === "a4"
            ? await createAmazonA4WithInvoices(
                pdfBytes,
                sourceDocument,
                selectedOrders,
              )
            : await createAmazonLabelModeWithInvoices(
                pdfBytes,
                sourceDocument,
                selectedOrders,
              );

        downloadPdf(
          outputBytes,
          `${
            printMode === "a4"
              ? "amazon-labels-invoices-a4"
              : "amazon-labels-invoices"
          }-${fileName || "cropped.pdf"}`,
        );

        return;
      }

      /*
       * AMAZON + WITHOUT INVOICE
       *
       * The generic label-only branch does not know which SKU belongs to
       * each page, so it cannot print SKU captions. Handle Amazon here
       * using selectedOrders for All / Single / Multi filters.
       */
      if (isAmazon && invoiceMode === "without") {
        const outputBytes =
          await createAmazonReferenceLabels(
            pdfBytes,
            selectedOrders,
            finalIndices,
            printMode,
          );

        downloadPdf(
          outputBytes,
          `${
            printMode === "a4"
              ? "amazon-reference-four-up-a4"
              : "amazon-reference-labels"
          }-${fileName || "cropped.pdf"}`,
        );

        return;
      }

      /*
       * FLIPKART + WITH INVOICE
       *
       * The source label and invoice are on the same PDF page.
       * Use selectedOrders so SKU sorting and All/Single/Multi filtering
       * remain correct.
       */
      if (isFlipkart && invoiceMode === "with") {
        const outputBytes =
          printMode === "a4"
            ? await createFlipkartA4WithInvoices(
                pdfBytes,
                selectedOrders,
              )
            : await createFlipkartLabelModeWithInvoices(
                pdfBytes,
                sourceDocument,
                selectedOrders,
              );

        downloadPdf(
          outputBytes,
          `${
            printMode === "a4"
              ? "flipkart-labels-invoices-a4"
              : "flipkart-labels-invoices"
          }-${fileName || "cropped.pdf"}`,
        );

        return;
      }

      /*
       * FLIPKART + WITHOUT INVOICE
       *
       * Labels (mm) => one 100mm x 150mm label per page.
       * A4 Mode     => four labels per A4 page.
       *
       * Both modes keep SKU sorting and All/Single/Multi filtering.
       */
      if (isFlipkart && invoiceMode === "without") {
        const outputBytes =
          await createFlipkartReferenceLabels(
            pdfBytes,
            selectedOrders,
            finalIndices,
            printMode,
          );

        downloadPdf(
          outputBytes,
          `${
            printMode === "a4"
              ? "flipkart-reference-four-up-a4"
              : "flipkart-reference-labels"
          }-${fileName || "cropped.pdf"}`,
        );

        return;
      }

      /*
       * MEESHO + WITHOUT INVOICE
       *
       * Match the supplied Meesho reference exactly:
       * - label page: 210mm × 130mm
       * - four-up page: 420mm × 260mm
       */
      if (
        isMeesho &&
        invoiceMode === "without"
      ) {
        const outputBytes =
          await createMeeshoReferenceLabels(
            pdfBytes,
            selectedOrders,
            finalIndices,
            printMode,
          );

        downloadPdf(
          outputBytes,
          `${
            printMode === "a4"
              ? "meesho-reference-four-up"
              : "meesho-reference-labels"
          }-${fileName || "cropped.pdf"}`,
        );

        return;
      }

      if (printMode === "a4") {
        const outputDocument = await PDFDocument.create();

        const labelsPerA4Page = isMeeshoWithInvoice ? 1 : 4;
        const columns = isMeeshoWithInvoice ? 1 : 2;

        const amazonLabelWidth = 283.46;
        const amazonLabelHeight = 425.2;

        const labelWidth = isAmazon
          ? amazonLabelWidth
          : isMeeshoWithInvoice
            ? A4_WIDTH_PT
            : A4_WIDTH_PT / columns;

        const labelHeight = isAmazon
          ? amazonLabelHeight
          : labelWidth / (crop.width / crop.height);

        const pageHeight = isMeeshoWithInvoice
          ? labelHeight
          : labelHeight * 2;

        const invoiceAspect = invoiceCrop
          ? invoiceCrop.width / invoiceCrop.height
          : 0;

        if (isFlipkartWithInvoice && invoiceCrop) {
          const invoiceWidth = A4_WIDTH_PT;
          const invoiceHeight =
            invoiceWidth / invoiceAspect;

          const flipkartPageHeight =
            labelHeight + invoiceHeight;

          for (const pageIndex of finalIndices) {
            const [labelPng, invoicePng] =
              await Promise.all([
                renderCroppedPageToPng(
                  pdfBytes,
                  pageIndex,
                  crop,
                ),
                renderCroppedPageToPng(
                  pdfBytes,
                  pageIndex,
                  invoiceCrop,
                ),
              ]);

            const [embeddedLabel, embeddedInvoice] =
              await Promise.all([
                outputDocument.embedPng(labelPng),
                outputDocument.embedPng(invoicePng),
              ]);

            const outputPage = outputDocument.addPage([
              A4_WIDTH_PT,
              flipkartPageHeight,
            ]);

            outputPage.drawImage(embeddedLabel, {
              x: 0,
              y: flipkartPageHeight - labelHeight,
              width: labelWidth,
              height: labelHeight,
            });

            outputPage.drawImage(embeddedInvoice, {
              x: 0,
              y: 0,
              width: invoiceWidth,
              height: invoiceHeight,
            });
          }
        } else {
          const labelImages: Array<{
            image: PDFImage;
            width: number;
            height: number;
          }> = [];

          for (const pageIndex of finalIndices) {
            const pngBytes = await renderCroppedPageToPng(
              pdfBytes,
              pageIndex,
              crop,
            );

            const embeddedPng =
              await outputDocument.embedPng(pngBytes);

            labelImages.push({
              image: embeddedPng,
              width: labelWidth,
              height: labelHeight,
            });
          }

          for (
            let start = 0;
            start < labelImages.length;
            start += labelsPerA4Page
          ) {
            const outputPage = outputDocument.addPage([
              A4_WIDTH_PT,
              pageHeight,
            ]);

            const batch = labelImages.slice(
              start,
              start + labelsPerA4Page,
            );

            batch.forEach((label, position) => {
              const column = position % columns;
              const row = Math.floor(position / columns);

              const x = column * labelWidth;
              const y =
                pageHeight - (row + 1) * labelHeight;

              outputPage.drawImage(label.image, {
                x,
                y,
                width: label.width,
                height: label.height,
              });
            });
          }
        }

        const outputBytes = await outputDocument.save();

        downloadPdf(
          outputBytes,
          `labels-a4-${fileName || "cropped.pdf"}`,
        );

        return;
      }

      const outputDocument = await PDFDocument.create();

      for (const pageIndex of finalIndices) {
        if (isFlipkartWithInvoice && invoiceCrop) {
          const labelBox = getCropBoxFromRegion(
            crop,
            sourceDocument,
            pageIndex,
          );

          const [labelPage] = await outputDocument.copyPages(
            sourceDocument,
            [pageIndex],
          );

          labelPage.setMediaBox(
            labelBox.x,
            labelBox.y,
            labelBox.width,
            labelBox.height,
          );

          outputDocument.addPage(labelPage);

          const invoiceBox = getCropBoxFromRegion(
            invoiceCrop,
            sourceDocument,
            pageIndex,
          );

          const [invoicePage] = await outputDocument.copyPages(
            sourceDocument,
            [pageIndex],
          );

          invoicePage.setMediaBox(
            invoiceBox.x,
            invoiceBox.y,
            invoiceBox.width,
            invoiceBox.height,
          );

          outputDocument.addPage(invoicePage);
        } else {
          const [copiedPage] = await outputDocument.copyPages(
            sourceDocument,
            [pageIndex],
          );

          const {
            width: pageWidth,
            height: pageHeight,
          } = copiedPage.getSize();

          const box = getCropBox(pageWidth, pageHeight);

          copiedPage.setMediaBox(
            box.x,
            box.y,
            box.width,
            box.height,
          );

          outputDocument.addPage(copiedPage);
        }
      }

      const outputBytes = await outputDocument.save();

      downloadPdf(
        outputBytes,
        `labels-${fileName || "cropped.pdf"}`,
      );
    } catch (downloadError) {
      console.error(downloadError);

      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Error cropping PDF. Please try again.",
      );
    } finally {
      setProcessing(false);
    }
  };

  const updateCrop = (
    key: keyof CropRegion,
    value: number,
  ) => {
    setCrop((previous) => ({
      ...previous,
      [key]: value,
    }));
  };

  const resetCrop = () => {
    setCrop(getEffectiveCrop());
  };

  const clearFile = () => {
    setPdfBytes(null);
    setPages([]);
    setFileName(null);
    setOrders([]);
    setError(null);
    onOrdersExtracted([]);
  };

  return (
    <div className="mx-auto max-w-2xl">
      {!pdfBytes && (
        <div
          {...getRootProps()}
          className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
            isDragActive
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950/60"
              : "border-gray-300 hover:border-blue-400 dark:border-neutral-700 dark:bg-neutral-950/40"
          } ${
            !pdfjs || processing
              ? "cursor-not-allowed opacity-60"
              : ""
          }`}
        >
          <input {...getInputProps()} />

          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            stroke="currentColor"
            fill="none"
            viewBox="0 0 48 48"
            aria-hidden="true"
          >
            <path
              d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          {!pdfjs ? (
            <p className="mt-2 text-gray-600 dark:text-neutral-300">
              Loading PDF engine...
            </p>
          ) : isDragActive ? (
            <p className="mt-2 text-blue-600">
              Drop the PDF here...
            </p>
          ) : (
            <p className="mt-2 text-gray-600 dark:text-neutral-300">
              Drag & drop a PDF here, or{" "}
              <span className="font-semibold text-blue-600">
                browse
              </span>
            </p>
          )}

          <p className="mt-1 text-sm text-gray-500 dark:text-neutral-400">
            PDF files only
          </p>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {fileName && pages.length > 0 && (
        <div className="mt-4">
          <div className="mb-4 flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-sm text-gray-500 dark:text-neutral-400">File</p>
              <p className="max-w-xs truncate font-medium text-gray-800 dark:text-neutral-100">
                {fileName}
              </p>
            </div>

            <div className="text-right">
              <p className="text-sm text-gray-500 dark:text-neutral-400">Pages</p>
              <p className="text-lg font-bold text-blue-600">
                {pages.length}
              </p>
            </div>
          </div>

          {orders.length > 0 && (
            <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
              <div className="border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
                <p className="text-sm font-semibold text-gray-800 dark:text-neutral-100">
                  Detected orders
                </p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-neutral-400">
                  This confirms the SKU and quantity used for
                  sorting/filtering.
                </p>
              </div>

              <div className="max-h-52 overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-white text-gray-500 dark:bg-neutral-950 dark:text-neutral-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">
                        Order
                      </th>
                      <th className="px-3 py-2 font-medium">
                        SKU
                      </th>
                      <th className="px-3 py-2 text-center font-medium">
                        Qty
                      </th>
                      <th className="px-3 py-2 text-center font-medium">
                        Type
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {orders.map((order) => {
                      const platform = String(
                        order.platform ?? "",
                      ).toLowerCase();

                      const isQuantityBased =
                        platform === "amazon" ||
                        platform === "flipkart";

                      const isMultiOrder = isQuantityBased
                        ? Number(order.quantity ?? 0) > 1
                        : Boolean(order.isMultiOrder);

                      return (
                        <tr
                          key={`${order.page}-${order.orderId}-${order.sku}`}
                          className="border-t border-gray-100 dark:border-neutral-800"
                        >
                          <td className="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-neutral-300">
                            {order.orderId || "-"}
                          </td>
                          <td className="px-3 py-2 font-medium text-gray-900 dark:text-neutral-100">
                            {order.sku || "Not detected"}
                          </td>
                          <td className="px-3 py-2 text-center text-gray-700 dark:text-neutral-300">
                            {order.quantity}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span
                              className={`rounded-full px-2 py-0.5 font-medium ${
                                isMultiOrder
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-green-100 text-green-700"
                              }`}
                            >
                              {isMultiOrder
                                ? "Multi"
                                : "Single"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-700 dark:text-neutral-200">
                Adjust Crop Area
              </p>

              <button
                type="button"
                onClick={resetCrop}
                className="cursor-pointer text-xs text-gray-500 underline hover:text-gray-700 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                Reset to default
              </button>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Slider
                label="Top"
                value={crop.top}
                onChange={(value) =>
                  updateCrop("top", value)
                }
                min={0}
                max={100}
              />

              <Slider
                label="Left"
                value={crop.left}
                onChange={(value) =>
                  updateCrop("left", value)
                }
                min={0}
                max={100}
              />

              <Slider
                label="Width"
                value={crop.width}
                onChange={(value) =>
                  updateCrop("width", value)
                }
                min={10}
                max={100}
              />

              <Slider
                label="Height"
                value={crop.height}
                onChange={(value) =>
                  updateCrop("height", value)
                }
                min={10}
                max={100}
              />
            </div>

            <p className="mt-3 text-center text-[11px] text-gray-400">
              Top {crop.top}% · Left {crop.left}% ·{" "}
              {crop.width}% × {crop.height}%
            </p>
          </div>

          <div className="max-h-96 space-y-4 overflow-y-auto pr-2">
            {pages.map((page) => (
              <div
                key={page.index}
                className="relative overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
              >
                <div className="absolute left-2 top-2 z-10 rounded bg-blue-600 px-2 py-1 text-xs font-bold text-white">
                  Page {page.index}
                </div>

                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={page.dataUrl}
                    alt={`Page ${page.index}`}
                    className="block h-auto w-full"
                    draggable={false}
                  />

                  {!(
                    isAmazon &&
                    invoiceMode === "with" &&
                    page.index % 2 === 0
                  ) && (
                    <div
                      className="pointer-events-none absolute border-2 border-dashed border-green-500"
                      style={{
                        top: `${crop.top}%`,
                        left: `${crop.left}%`,
                        width: `${crop.width}%`,
                        height: `${crop.height}%`,
                      }}
                    >
                      <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-green-600">
                        Label
                      </span>
                    </div>
                  )}

                  {isAmazon &&
                    invoiceMode === "with" &&
                    page.index % 2 === 0 && (
                      <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-orange-500">
                        <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
                          Full Invoice
                        </span>
                      </div>
                    )}

                  {isFlipkartWithInvoice && invoiceCrop && (
                    <div
                      className="pointer-events-none absolute border-2 border-dashed border-orange-500"
                      style={{
                        top: `${invoiceCrop.top}%`,
                        left: `${invoiceCrop.left}%`,
                        width: `${invoiceCrop.width}%`,
                        height: `${invoiceCrop.height}%`,
                      }}
                    >
                      <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
                        Invoice
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => void handleDownload()}
              disabled={processing}
              className="flex-1 cursor-pointer rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {processing
                ? "Processing..."
                : "Download Cropped PDF"}
            </button>

            <button
              type="button"
              onClick={clearFile}
              disabled={processing}
              className="cursor-pointer rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs font-medium text-gray-600 dark:text-neutral-300">
          {label}
        </label>

        <span className="font-mono text-xs text-gray-500 dark:text-neutral-400">
          {value}%
        </span>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) =>
          onChange(Number(event.target.value))
        }
        className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-indigo-600"
      />
    </div>
  );
}
// "use client";

// import { useCallback, useEffect, useMemo, useState } from "react";
// import { useDropzone } from "react-dropzone";
// import {
//   PDFDocument,
//   StandardFonts,
//   type PDFImage,
//   type PDFPage,
// } from "pdf-lib";

// import type { CropConfig } from "@/lib/crop-config";
// import type { OrderData } from "@/lib/parsers/types";
// import type { SortMode, FilterMode } from "./FilterOptions";

// import { extractOrders } from "@/lib/parsers";
// import { sortOrders } from "@/lib/parsers/sort";
// import { filterOrders } from "@/lib/parsers/filter";
// import { getPlatformId } from "@/lib/platforms";

// interface PDFCropToolProps {
//   config: CropConfig;
//   printMode: "label" | "a4";
//   platformName: string;
//   invoiceMode: "with" | "without";
//   sortMode: SortMode;
//   filterMode: FilterMode;
//   onOrdersExtracted: (orders: OrderData[]) => void;
// }

// interface PageData {
//   index: number;
//   width: number;
//   height: number;
//   dataUrl: string;
// }

// interface CropRegion {
//   top: number;
//   left: number;
//   width: number;
//   height: number;
// }

// type PdfJsModule = typeof import("pdfjs-dist");

// const A4_WIDTH_PT = 595.28;
// const A4_HEIGHT_PT = 841.89;

// const MM_TO_PT = 72 / 25.4;

// /**
//  * Exact physical thermal-label sizes.
//  *
//  * Amazon  : 100 mm × 150 mm
//  * Flipkart:  75 mm × 125 mm
//  * Meesho  : 100 mm × 150 mm
//  */
// const AMAZON_LABEL_WIDTH_PT = 100 * MM_TO_PT;
// const AMAZON_LABEL_HEIGHT_PT = 150 * MM_TO_PT;

// const FLIPKART_LABEL_WIDTH_PT = 75 * MM_TO_PT;
// const FLIPKART_LABEL_HEIGHT_PT = 125 * MM_TO_PT;

// const MEESHO_LABEL_WIDTH_PT = 100 * MM_TO_PT;
// const MEESHO_LABEL_HEIGHT_PT = 150 * MM_TO_PT;

// /**
//  * A4 portrait is 210mm × 297mm.
//  *
//  * Four exact 100mm × 150mm labels need 200mm × 300mm, so they are
//  * 3mm taller than A4. For Amazon and Meesho A4 four-up mode, only
//  * the height is reduced by 1.5mm:
//  *
//  * 100mm × 148.5mm, arranged as 2 columns × 2 rows.
//  *
//  * Normal Labels (mm) output remains exactly 100mm × 150mm.
//  */
// const A4_FOUR_UP_100MM_WIDTH_PT = 100 * MM_TO_PT;
// const A4_FOUR_UP_148_5MM_HEIGHT_PT = 148.5 * MM_TO_PT;

// const FULL_PAGE_REGION: CropRegion = {
//   top: 0,
//   left: 0,
//   width: 100,
//   height: 100,
// };

// function cloneArrayBuffer(source: ArrayBuffer): ArrayBuffer {
//   const copy = new ArrayBuffer(source.byteLength);
//   new Uint8Array(copy).set(new Uint8Array(source));
//   return copy;
// }

// function downloadPdf(bytes: Uint8Array, fileName: string): void {
//   const blob = new Blob([bytes], {
//     type: "application/pdf",
//   });

//   const url = URL.createObjectURL(blob);
//   const link = document.createElement("a");

//   link.href = url;
//   link.download = fileName;
//   document.body.appendChild(link);
//   link.click();
//   link.remove();

//   window.setTimeout(() => URL.revokeObjectURL(url), 1000);
// }

// function drawImageContained(
//   page: PDFPage,
//   image: PDFImage,
//   box: {
//     x: number;
//     y: number;
//     width: number;
//     height: number;
//   },
// ): void {
//   const scale = Math.min(
//     box.width / image.width,
//     box.height / image.height,
//   );

//   const width = image.width * scale;
//   const height = image.height * scale;

//   page.drawImage(image, {
//     x: box.x + (box.width - width) / 2,
//     y: box.y + (box.height - height) / 2,
//     width,
//     height,
//   });
// }

// function shortenText(value: string, maximumLength: number): string {
//   if (value.length <= maximumLength) return value;
//   return `${value.slice(0, maximumLength - 3)}...`;
// }

// export default function PDFCropTool({
//   config,
//   printMode,
//   platformName,
//   invoiceMode,
//   sortMode,
//   filterMode,
//   onOrdersExtracted,
// }: PDFCropToolProps) {
//   const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
//   const [pages, setPages] = useState<PageData[]>([]);
//   const [fileName, setFileName] = useState<string | null>(null);
//   const [error, setError] = useState<string | null>(null);
//   const [processing, setProcessing] = useState(false);
//   const [pdfjs, setPdfjs] = useState<PdfJsModule | null>(null);
//   const [orders, setOrders] = useState<OrderData[]>([]);

//   const getEffectiveCrop = useCallback((): CropRegion => {
//     if (platformName === "Meesho" && invoiceMode === "with") {
//       return {
//         top: 1,
//         left: 2,
//         width: 97,
//         height: 78.5,
//       };
//     }

//     return config.region;
//   }, [config.region, invoiceMode, platformName]);

//   const [crop, setCrop] = useState<CropRegion>(() =>
//     getEffectiveCrop(),
//   );

//   useEffect(() => {
//     setCrop(getEffectiveCrop());
//   }, [getEffectiveCrop]);

//   useEffect(() => {
//     let active = true;

//     const loadPdfjs = async () => {
//       try {
//         const pdfJsModule = await import("pdfjs-dist");
//         pdfJsModule.GlobalWorkerOptions.workerSrc =
//           "/pdf.worker.min.mjs";

//         if (active) {
//           setPdfjs(pdfJsModule);
//         }
//       } catch (loadError) {
//         console.error(loadError);

//         if (active) {
//           setError("Could not load the PDF engine.");
//         }
//       }
//     };

//     void loadPdfjs();

//     return () => {
//       active = false;
//     };
//   }, []);

//   const isFlipkartWithInvoice =
//     platformName === "Flipkart" && invoiceMode === "with";

//   const isMeeshoWithInvoice =
//     platformName === "Meesho" && invoiceMode === "with";

//   const isAmazon = platformName === "Amazon";
//   const isFlipkart = platformName === "Flipkart";
//   const isMeesho = platformName === "Meesho";

//   const renderPages = useCallback(
//     async (bytes: ArrayBuffer): Promise<PageData[]> => {
//       if (!pdfjs) return [];

//       const doc = await pdfjs.getDocument({
//         data: cloneArrayBuffer(bytes),
//       }).promise;

//       const newPages: PageData[] = [];

//       for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
//         /*
//          * Amazon original PDF:
//          * odd PDF pages = labels
//          * even PDF pages = invoices
//          *
//          * "Without Invoice" preview should show labels only.
//          */
//         if (
//           platformName === "Amazon" &&
//           invoiceMode === "without" &&
//           pageNumber % 2 === 0
//         ) {
//           continue;
//         }

//         const page = await doc.getPage(pageNumber);
//         const viewport = page.getViewport({ scale: 1.5 });

//         const canvas = document.createElement("canvas");
//         canvas.width = Math.ceil(viewport.width);
//         canvas.height = Math.ceil(viewport.height);

//         const context = canvas.getContext("2d");

//         if (!context) {
//           throw new Error("Canvas is not available.");
//         }

//         context.fillStyle = "#ffffff";
//         context.fillRect(0, 0, canvas.width, canvas.height);

//         await page.render({
//           canvas,
//           canvasContext: context,
//           viewport,
//         }).promise;

//         newPages.push({
//           index: pageNumber,
//           width: viewport.width,
//           height: viewport.height,
//           dataUrl: canvas.toDataURL("image/png"),
//         });
//       }

//       return newPages;
//     },
//     [invoiceMode, pdfjs, platformName],
//   );

//   useEffect(() => {
//     let cancelled = false;

//     const syncPages = async () => {
//       if (!pdfBytes || !pdfjs) return;

//       try {
//         const nextPages = await renderPages(pdfBytes);

//         if (!cancelled) {
//           setPages(nextPages);
//         }
//       } catch (renderError) {
//         console.error(renderError);

//         if (!cancelled) {
//           setError("Could not refresh the PDF preview.");
//         }
//       }
//     };

//     void syncPages();

//     return () => {
//       cancelled = true;
//     };
//   }, [invoiceMode, pdfBytes, pdfjs, renderPages]);

//   const onDrop = useCallback(
//     async (acceptedFiles: File[]) => {
//       setError(null);
//       setPages([]);
//       setFileName(null);
//       setPdfBytes(null);
//       setOrders([]);
//       onOrdersExtracted([]);

//       if (acceptedFiles.length === 0) return;

//       if (!pdfjs) {
//         setError("PDF engine is still loading. Please try again.");
//         return;
//       }

//       const file = acceptedFiles[0];

//       if (
//         file.type !== "application/pdf" &&
//         !file.name.toLowerCase().endsWith(".pdf")
//       ) {
//         setError("Please upload a PDF file.");
//         return;
//       }

//       setFileName(file.name);

//       try {
//         const bytes = await file.arrayBuffer();

//         const [renderedPages, extractedOrders] = await Promise.all([
//           renderPages(bytes),
//           (async () => {
//             const platformId = getPlatformId(platformName);

//             if (!platformId) {
//               throw new Error(
//                 `Could not resolve platform: ${platformName}`,
//               );
//             }

//             return extractOrders(bytes, platformId);
//           })(),
//         ]);

//         console.log(
//           "Extracted orders:",
//           extractedOrders.map((order) => ({
//             page: order.page,
//             orderId: order.orderId,
//             sku: order.sku,
//             quantity: order.quantity,
//             isMultiOrder: order.isMultiOrder,
//           })),
//         );

//         setPdfBytes(bytes);
//         setPages(renderedPages);
//         setOrders(extractedOrders);
//         onOrdersExtracted(extractedOrders);

//         if (
//           platformName === "Amazon" &&
//           extractedOrders.length === 0
//         ) {
//           setError(
//             "No Amazon invoice data was detected. Check the browser console for parser details.",
//           );
//         }
//       } catch (dropError) {
//         console.error(dropError);
//         setError(
//           dropError instanceof Error
//             ? dropError.message
//             : "Error reading PDF. Please try again.",
//         );
//       }
//     },
//     [onOrdersExtracted, pdfjs, platformName, renderPages],
//   );

//   const { getRootProps, getInputProps, isDragActive } =
//     useDropzone({
//       onDrop,
//       accept: {
//         "application/pdf": [".pdf"],
//       },
//       maxFiles: 1,
//       multiple: false,
//       disabled: processing || !pdfjs,
//     });

//   const getCropBox = (
//     pageWidth: number,
//     pageHeight: number,
//   ) => {
//     const widthRatio = crop.width / 100;
//     const heightRatio = crop.height / 100;
//     const topOffset = crop.top / 100;
//     const leftOffset = crop.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const getCropBoxFromRegion = (
//     region: CropRegion,
//     sourceDocument: PDFDocument,
//     pageIndex: number,
//   ) => {
//     const page = sourceDocument.getPage(pageIndex);
//     const { width: pageWidth, height: pageHeight } =
//       page.getSize();

//     const widthRatio = region.width / 100;
//     const heightRatio = region.height / 100;
//     const topOffset = region.top / 100;
//     const leftOffset = region.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const invoiceCrop = config.invoiceRegion;

//   const renderCroppedPageToPng = async (
//     sourceBytes: ArrayBuffer,
//     pageIndex: number,
//     cropRegion: CropRegion = crop,
//   ): Promise<Uint8Array> => {
//     if (!pdfjs) {
//       throw new Error("PDF renderer is not ready.");
//     }

//     const scale = 2;

//     const doc = await pdfjs.getDocument({
//       data: cloneArrayBuffer(sourceBytes),
//     }).promise;

//     if (pageIndex < 0 || pageIndex >= doc.numPages) {
//       throw new Error(
//         `PDF page ${pageIndex + 1} does not exist.`,
//       );
//     }

//     const page = await doc.getPage(pageIndex + 1);
//     const viewport = page.getViewport({ scale });

//     const canvas = document.createElement("canvas");
//     canvas.width = Math.ceil(viewport.width);
//     canvas.height = Math.ceil(viewport.height);

//     const context = canvas.getContext("2d");

//     if (!context) {
//       throw new Error("Canvas is not available.");
//     }

//     context.fillStyle = "#ffffff";
//     context.fillRect(0, 0, canvas.width, canvas.height);

//     await page.render({
//       canvas,
//       canvasContext: context,
//       viewport,
//     }).promise;

//     const cropX = Math.max(
//       0,
//       Math.floor((viewport.width * cropRegion.left) / 100),
//     );

//     const cropY = Math.max(
//       0,
//       Math.floor((viewport.height * cropRegion.top) / 100),
//     );

//     const cropWidth = Math.max(
//       1,
//       Math.min(
//         canvas.width - cropX,
//         Math.floor((viewport.width * cropRegion.width) / 100),
//       ),
//     );

//     const cropHeight = Math.max(
//       1,
//       Math.min(
//         canvas.height - cropY,
//         Math.floor((viewport.height * cropRegion.height) / 100),
//       ),
//     );

//     const croppedCanvas = document.createElement("canvas");
//     croppedCanvas.width = cropWidth;
//     croppedCanvas.height = cropHeight;

//     const croppedContext = croppedCanvas.getContext("2d");

//     if (!croppedContext) {
//       throw new Error("Crop canvas is not available.");
//     }

//     croppedContext.fillStyle = "#ffffff";
//     croppedContext.fillRect(
//       0,
//       0,
//       croppedCanvas.width,
//       croppedCanvas.height,
//     );

//     croppedContext.drawImage(
//       canvas,
//       cropX,
//       cropY,
//       cropWidth,
//       cropHeight,
//       0,
//       0,
//       cropWidth,
//       cropHeight,
//     );

//     const blob = await new Promise<Blob>((resolve, reject) => {
//       croppedCanvas.toBlob((result) => {
//         if (!result) {
//           reject(new Error("Could not create cropped PDF image."));
//           return;
//         }

//         resolve(result);
//       }, "image/png");
//     });

//     return new Uint8Array(await blob.arrayBuffer());
//   };

//   const filteredAndSortedOrders = useMemo(() => {
//     const filtered = filterOrders(orders, filterMode);
//     return sortOrders(filtered, sortMode);
//   }, [filterMode, orders, sortMode]);

//   interface FixedLabelEntry {
//     pageIndex: number;
//     order: OrderData | null;
//   }

//   const getFixedLabelEntries = (
//     selectedOrders: OrderData[],
//     pageIndices: number[],
//   ): FixedLabelEntry[] => {
//     if (selectedOrders.length > 0) {
//       return selectedOrders.map((order) => ({
//         pageIndex: order.page - 1,
//         order,
//       }));
//     }

//     return pageIndices.map((pageIndex) => ({
//       pageIndex,
//       order: null,
//     }));
//   };

//   /**
//    * Creates one exact physical-size PDF page per shipping label.
//    */
//   const createExactLabelModePdf = async ({
//     sourceBytes,
//     selectedOrders,
//     pageIndices,
//     labelWidth,
//     labelHeight,
//     showSkuCaption,
//   }: {
//     sourceBytes: ArrayBuffer;
//     selectedOrders: OrderData[];
//     pageIndices: number[];
//     labelWidth: number;
//     labelHeight: number;
//     showSkuCaption: boolean;
//   }): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const entries = getFixedLabelEntries(
//       selectedOrders,
//       pageIndices,
//     );

//     const captionHeight = showSkuCaption ? 22 : 0;
//     const padding = 5;

//     for (
//       let entryIndex = 0;
//       entryIndex < entries.length;
//       entryIndex += 1
//     ) {
//       const entry = entries[entryIndex];

//       if (entry.pageIndex < 0) {
//         throw new Error(
//           `Label page ${entry.pageIndex + 1} is invalid.`,
//         );
//       }

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         entry.pageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const outputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(outputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       if (showSkuCaption && entry.order) {
//         outputPage.drawText(
//           shortenText(
//             `${entry.order.sku} | Qty - ${entry.order.quantity}`,
//             labelWidth <= FLIPKART_LABEL_WIDTH_PT + 1
//               ? 32
//               : 42,
//           ),
//           {
//             x: padding + 1,
//             y: 8,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         outputPage.drawText(
//           `Order - ${entryIndex + 1}`,
//           {
//             x:
//               labelWidth -
//               (labelWidth <= FLIPKART_LABEL_WIDTH_PT + 1
//                 ? 55
//                 : 62),
//             y: 8,
//             size: 7,
//             font: regularFont,
//           },
//         );
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Places exact-size physical labels on a true A4 PDF page.
//    *
//    * Amazon/Meesho:
//    *   4 labels per A4 page using 100mm × 148.5mm A4-fit boxes.
//    *   Their standalone Labels (mm) pages remain exactly 100mm × 150mm.
//    *
//    * Flipkart 75x125:
//    *   4 exact-size labels per A4 page (2 columns × 2 rows).
//    */
//   const createExactA4LabelPdf = async ({
//     sourceBytes,
//     selectedOrders,
//     pageIndices,
//     labelWidth,
//     labelHeight,
//     columns,
//     rows,
//     horizontalGapMm,
//     verticalGapMm,
//     showSkuCaption,
//   }: {
//     sourceBytes: ArrayBuffer;
//     selectedOrders: OrderData[];
//     pageIndices: number[];
//     labelWidth: number;
//     labelHeight: number;
//     columns: number;
//     rows: number;
//     horizontalGapMm: number;
//     verticalGapMm: number;
//     showSkuCaption: boolean;
//   }): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const entries = getFixedLabelEntries(
//       selectedOrders,
//       pageIndices,
//     );

//     const labelsPerPage = columns * rows;

//     const horizontalGap =
//       horizontalGapMm * MM_TO_PT;

//     const verticalGap =
//       verticalGapMm * MM_TO_PT;

//     const gridWidth =
//       columns * labelWidth +
//       Math.max(0, columns - 1) * horizontalGap;

//     const gridHeight =
//       rows * labelHeight +
//       Math.max(0, rows - 1) * verticalGap;

//     if (
//       gridWidth > A4_WIDTH_PT ||
//       gridHeight > A4_HEIGHT_PT
//     ) {
//       throw new Error(
//         "The selected physical label layout does not fit on A4.",
//       );
//     }

//     const gridStartX =
//       (A4_WIDTH_PT - gridWidth) / 2;

//     const gridStartY =
//       (A4_HEIGHT_PT - gridHeight) / 2;

//     const captionHeight = showSkuCaption ? 22 : 0;
//     const padding = 5;

//     for (
//       let entryStart = 0;
//       entryStart < entries.length;
//       entryStart += labelsPerPage
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = entries.slice(
//         entryStart,
//         entryStart + labelsPerPage,
//       );

//       for (
//         let position = 0;
//         position < batch.length;
//         position += 1
//       ) {
//         const entry = batch[position];

//         if (entry.pageIndex < 0) {
//           throw new Error(
//             `Label page ${entry.pageIndex + 1} is invalid.`,
//           );
//         }

//         const labelPng = await renderCroppedPageToPng(
//           sourceBytes,
//           entry.pageIndex,
//           crop,
//         );

//         const labelImage =
//           await outputDocument.embedPng(labelPng);

//         const column = position % columns;
//         const row = Math.floor(position / columns);

//         const labelX =
//           gridStartX +
//           column * (labelWidth + horizontalGap);

//         const labelY =
//           A4_HEIGHT_PT -
//           gridStartY -
//           (row + 1) * labelHeight -
//           row * verticalGap;

//         /*
//          * Image and caption stay inside the exact physical label box.
//          */
//         drawImageContained(outputPage, labelImage, {
//           x: labelX + padding,
//           y: labelY + captionHeight + padding,
//           width: labelWidth - padding * 2,
//           height:
//             labelHeight -
//             captionHeight -
//             padding * 2,
//         });

//         if (showSkuCaption && entry.order) {
//           const displayOrderNumber =
//             entryStart + position + 1;

//           outputPage.drawText(
//             shortenText(
//               `${entry.order.sku} | Qty - ${entry.order.quantity}`,
//               labelWidth <= FLIPKART_LABEL_WIDTH_PT + 1
//                 ? 32
//                 : 42,
//             ),
//             {
//               x: labelX + padding + 1,
//               y: labelY + 8,
//               size: 7,
//               font: boldFont,
//             },
//           );

//           outputPage.drawText(
//             `Order - ${displayOrderNumber}`,
//             {
//               x:
//                 labelX +
//                 labelWidth -
//                 (labelWidth <=
//                 FLIPKART_LABEL_WIDTH_PT + 1
//                   ? 55
//                   : 62),
//               y: labelY + 8,
//               size: 7,
//               font: regularFont,
//             },
//           );
//         }
//       }
//     }

//     return outputDocument.save();
//   };

//   const createAmazonA4WithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const rowHeight = A4_HEIGHT_PT / 2;
//     const columnWidth = A4_WIDTH_PT / 2;
//     const captionHeight = 20;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += 2
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + 2,
//       );

//       for (let slot = 0; slot < batch.length; slot += 1) {
//         const order = batch[slot];

//         /*
//          * order.page is the one-based shipping-label page.
//          * The matching invoice is the immediately following page.
//          */
//         const labelPageIndex = order.page - 1;
//         const invoicePageIndex = labelPageIndex + 1;

//         if (
//           labelPageIndex < 0 ||
//           invoicePageIndex >= sourceDocument.getPageCount()
//         ) {
//           throw new Error(
//             `Invoice pair is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const [labelPng, invoicePng] = await Promise.all([
//           renderCroppedPageToPng(
//             sourceBytes,
//             labelPageIndex,
//             crop,
//           ),
//           renderCroppedPageToPng(
//             sourceBytes,
//             invoicePageIndex,
//             FULL_PAGE_REGION,
//           ),
//         ]);

//         const [labelImage, invoiceImage] = await Promise.all([
//           outputDocument.embedPng(labelPng),
//           outputDocument.embedPng(invoicePng),
//         ]);

//         const rowBottom =
//           A4_HEIGHT_PT - (slot + 1) * rowHeight;

//         const contentY =
//           rowBottom + captionHeight + padding;

//         const contentHeight =
//           rowHeight - captionHeight - padding * 2;

//         drawImageContained(outputPage, labelImage, {
//           x: padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         drawImageContained(outputPage, invoiceImage, {
//           x: columnWidth + padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         const displayOrderNumber = orderStart + slot + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             48,
//           ),
//           {
//             x: padding + 2,
//             y: rowBottom + 7,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         const orderCaption = `Order - ${displayOrderNumber}`;

//         outputPage.drawText(orderCaption, {
//           x: columnWidth - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });

//         outputPage.drawText(orderCaption, {
//           x: A4_WIDTH_PT - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITH invoice, label/mm mode:
//    *
//    * Output sequence:
//    * 1. Cropped label page with SKU + Qty caption
//    * 2. Matching full invoice page
//    */
//   const createAmazonLabelModeWithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = AMAZON_LABEL_WIDTH_PT;
//     const labelHeight = AMAZON_LABEL_HEIGHT_PT;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];

//       const labelPageIndex = order.page - 1;
//       const invoicePageIndex = labelPageIndex + 1;

//       if (
//         labelPageIndex < 0 ||
//         invoicePageIndex >= sourceDocument.getPageCount()
//       ) {
//         throw new Error(
//           `Invoice pair is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       /*
//        * Render the cropped shipping label as an image so we can reserve
//        * space at the bottom for SKU and quantity.
//        */
//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         labelPageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const labelOutputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(labelOutputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       labelOutputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       labelOutputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );

//       /*
//        * Add the matching complete invoice immediately after its label.
//        */
//       const [invoicePage] =
//         await outputDocument.copyPages(
//           sourceDocument,
//           [invoicePageIndex],
//         );

//       outputDocument.addPage(invoicePage);
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITHOUT invoice, A4 mode:
//    *
//    * 4 labels per A4 page (2 columns x 2 rows).
//    * Every label gets its SKU and quantity caption.
//    */
//   const createAmazonA4WithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const columns = 2;
//     const rows = 2;
//     const labelsPerPage = columns * rows;

//     const cellWidth = A4_WIDTH_PT / columns;
//     const cellHeight = A4_HEIGHT_PT / rows;

//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += labelsPerPage
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + labelsPerPage,
//       );

//       for (
//         let position = 0;
//         position < batch.length;
//         position += 1
//       ) {
//         const order = batch[position];
//         const labelPageIndex = order.page - 1;

//         if (labelPageIndex < 0) {
//           throw new Error(
//             `Label page is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const labelPng = await renderCroppedPageToPng(
//           sourceBytes,
//           labelPageIndex,
//           crop,
//         );

//         const labelImage =
//           await outputDocument.embedPng(labelPng);

//         const column = position % columns;
//         const row = Math.floor(position / columns);

//         const cellX = column * cellWidth;
//         const cellBottom =
//           A4_HEIGHT_PT - (row + 1) * cellHeight;

//         drawImageContained(outputPage, labelImage, {
//           x: cellX + padding,
//           y: cellBottom + captionHeight + padding,
//           width: cellWidth - padding * 2,
//           height:
//             cellHeight -
//             captionHeight -
//             padding * 2,
//         });

//         const displayOrderNumber =
//           orderStart + position + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             42,
//           ),
//           {
//             x: cellX + padding + 2,
//             y: cellBottom + 8,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         outputPage.drawText(
//           `Order - ${displayOrderNumber}`,
//           {
//             x: cellX + cellWidth - 58,
//             y: cellBottom + 8,
//             size: 7,
//             font: regularFont,
//           },
//         );
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITHOUT invoice, label/mm mode:
//    *
//    * One 100 mm x 150 mm output page per label.
//    * SKU and quantity are printed at the bottom of every page.
//    */
//   const createAmazonLabelModeWithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = AMAZON_LABEL_WIDTH_PT;
//     const labelHeight = AMAZON_LABEL_HEIGHT_PT;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const labelPageIndex = order.page - 1;

//       if (labelPageIndex < 0) {
//         throw new Error(
//           `Label page is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         labelPageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const outputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(outputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       outputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       outputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Flipkart WITH invoice, A4 mode.
//    *
//    * Each source page contains both the shipping label and invoice.
//    * The output keeps one order per A4 page and adds SKU + Qty between
//    * the label and invoice.
//    */
//   const createFlipkartA4WithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     if (!invoiceCrop) {
//       throw new Error(
//         "Flipkart invoice crop region is not configured.",
//       );
//     }

//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const margin = 8;
//     const captionHeight = 22;
//     const gap = 5;

//     const contentHeight =
//       A4_HEIGHT_PT -
//       margin * 2 -
//       captionHeight -
//       gap;

//     const labelAreaHeight = contentHeight * 0.42;
//     const invoiceAreaHeight =
//       contentHeight - labelAreaHeight;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const pageIndex = order.page - 1;

//       const [labelPng, invoicePng] = await Promise.all([
//         renderCroppedPageToPng(
//           sourceBytes,
//           pageIndex,
//           crop,
//         ),
//         renderCroppedPageToPng(
//           sourceBytes,
//           pageIndex,
//           invoiceCrop,
//         ),
//       ]);

//       const [labelImage, invoiceImage] =
//         await Promise.all([
//           outputDocument.embedPng(labelPng),
//           outputDocument.embedPng(invoicePng),
//         ]);

//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       drawImageContained(outputPage, invoiceImage, {
//         x: margin,
//         y: margin,
//         width: A4_WIDTH_PT - margin * 2,
//         height: invoiceAreaHeight,
//       });

//       const captionY =
//         margin + invoiceAreaHeight + 7;

//       outputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           65,
//         ),
//         {
//           x: margin + 3,
//           y: captionY,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       outputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: A4_WIDTH_PT - 67,
//           y: captionY,
//           size: 8,
//           font: regularFont,
//         },
//       );

//       drawImageContained(outputPage, labelImage, {
//         x: margin,
//         y:
//           margin +
//           invoiceAreaHeight +
//           captionHeight +
//           gap,
//         width: A4_WIDTH_PT - margin * 2,
//         height: labelAreaHeight,
//       });
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Flipkart WITH invoice, label/mm mode.
//    *
//    * Output sequence:
//    * 1. 100mm x 150mm label page with SKU + Qty
//    * 2. Matching cropped invoice page
//    */
//   const createFlipkartLabelModeWithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     if (!invoiceCrop) {
//       throw new Error(
//         "Flipkart invoice crop region is not configured.",
//       );
//     }

//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     /*
//      * Exact Flipkart label page size: 75mm × 125mm.
//      * SKU/Qty caption is kept inside this fixed-size page.
//      */
//     const labelWidth = FLIPKART_LABEL_WIDTH_PT;
//     const labelHeight = FLIPKART_LABEL_HEIGHT_PT;
//     const captionHeight = 20;
//     const padding = 5;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const pageIndex = order.page - 1;

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         pageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const labelPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(labelPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       labelPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           32,
//         ),
//         {
//           x: padding + 1,
//           y: 7,
//           size: 7,
//           font: boldFont,
//         },
//       );

//       labelPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 55,
//           y: 7,
//           size: 7,
//           font: regularFont,
//         },
//       );

//       /*
//        * Add the matching cropped invoice immediately after its
//        * fixed-size 75mm × 125mm label page.
//        */
//       const invoiceBox = getCropBoxFromRegion(
//         invoiceCrop,
//         sourceDocument,
//         pageIndex,
//       );

//       const [invoicePage] =
//         await outputDocument.copyPages(
//           sourceDocument,
//           [pageIndex],
//         );

//       invoicePage.setMediaBox(
//         invoiceBox.x,
//         invoiceBox.y,
//         invoiceBox.width,
//         invoiceBox.height,
//       );

//       outputDocument.addPage(invoicePage);
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Flipkart WITHOUT invoice, A4 mode.
//    *
//    * Four labels are placed on one A4 page in a 2 x 2 grid.
//    * SKU and quantity are printed under every label.
//    */
//   const createFlipkartA4WithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const columns = 2;
//     const rows = 2;
//     const labelsPerPage = columns * rows;

//     /*
//      * Each label remains exactly 75mm × 125mm on the A4 sheet.
//      * Four labels fit as a centered 2 × 2 grid.
//      */
//     const labelWidth = FLIPKART_LABEL_WIDTH_PT;
//     const labelHeight = FLIPKART_LABEL_HEIGHT_PT;

//     const horizontalGap = 10 * MM_TO_PT;
//     const verticalGap = 10 * MM_TO_PT;

//     const gridWidth =
//       columns * labelWidth +
//       (columns - 1) * horizontalGap;

//     const gridHeight =
//       rows * labelHeight +
//       (rows - 1) * verticalGap;

//     const gridStartX =
//       (A4_WIDTH_PT - gridWidth) / 2;

//     const gridStartY =
//       (A4_HEIGHT_PT - gridHeight) / 2;

//     const captionHeight = 20;
//     const padding = 5;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += labelsPerPage
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + labelsPerPage,
//       );

//       for (
//         let position = 0;
//         position < batch.length;
//         position += 1
//       ) {
//         const order = batch[position];
//         const pageIndex = order.page - 1;

//         if (pageIndex < 0) {
//           throw new Error(
//             `Label page is missing for Flipkart order ${order.orderId}.`,
//           );
//         }

//         const labelPng = await renderCroppedPageToPng(
//           sourceBytes,
//           pageIndex,
//           crop,
//         );

//         const labelImage =
//           await outputDocument.embedPng(labelPng);

//         const column = position % columns;
//         const row = Math.floor(position / columns);

//         const labelX =
//           gridStartX +
//           column * (labelWidth + horizontalGap);

//         const labelY =
//           A4_HEIGHT_PT -
//           gridStartY -
//           (row + 1) * labelHeight -
//           row * verticalGap;

//         /*
//          * The image and caption stay inside the exact 75mm × 125mm
//          * physical label area.
//          */
//         drawImageContained(outputPage, labelImage, {
//           x: labelX + padding,
//           y: labelY + captionHeight + padding,
//           width: labelWidth - padding * 2,
//           height:
//             labelHeight -
//             captionHeight -
//             padding * 2,
//         });

//         const displayOrderNumber =
//           orderStart + position + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             32,
//           ),
//           {
//             x: labelX + padding + 1,
//             y: labelY + 7,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         outputPage.drawText(
//           `Order - ${displayOrderNumber}`,
//           {
//             x: labelX + labelWidth - 55,
//             y: labelY + 7,
//             size: 7,
//             font: regularFont,
//           },
//         );
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Flipkart WITHOUT invoice, label/mm mode.
//    *
//    * A4 is disabled in page.tsx for this mode.
//    * Every label still displays SKU + Qty and respects the selected filter.
//    */
//   const createFlipkartLabelModeWithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     /*
//      * Exact Flipkart thermal-label page size: 75mm × 125mm.
//      */
//     const labelWidth = FLIPKART_LABEL_WIDTH_PT;
//     const labelHeight = FLIPKART_LABEL_HEIGHT_PT;
//     const captionHeight = 20;
//     const padding = 5;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const pageIndex = order.page - 1;

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         pageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const outputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(outputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       outputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           32,
//         ),
//         {
//           x: padding + 1,
//           y: 7,
//           size: 7,
//           font: boldFont,
//         },
//       );

//       outputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 55,
//           y: 7,
//           size: 7,
//           font: regularFont,
//         },
//       );
//     }

//     return outputDocument.save();
//   };

//   const handleDownload = async () => {
//     if (!pdfBytes || pages.length === 0) return;

//     setProcessing(true);
//     setError(null);

//     try {
//       const sourceDocument = await PDFDocument.load(
//         cloneArrayBuffer(pdfBytes),
//       );

//       let sourcePageIndices = sourceDocument.getPageIndices();

//       if (isAmazon && invoiceMode === "without") {
//         sourcePageIndices = sourcePageIndices.filter(
//           (pageIndex) => pageIndex % 2 === 0,
//         );
//       }

//       if (isAmazon && orders.length === 0) {
//         throw new Error(
//           "Amazon order data was not detected. OCR is not required for this PDF; verify that amazon.ts is replaced with the updated parser.",
//         );
//       }

//       if (isFlipkart && orders.length === 0) {
//         throw new Error(
//           "Flipkart order data was not detected. Verify that flipkart.ts is replaced with the updated parser.",
//         );
//       }

//       if (orders.length === 0 && filterMode !== "all") {
//         throw new Error(
//           "Could not detect single/multi order details. Use All Orders or verify the parser output.",
//         );
//       }

//       const selectedOrders = filteredAndSortedOrders;

//       if (
//         filterMode !== "all" &&
//         selectedOrders.length === 0
//       ) {
//         throw new Error(
//           `No ${
//             filterMode === "single" ? "single" : "multi"
//           } orders were detected in this PDF.`,
//         );
//       }

//       const sortedLabelPageIndices = selectedOrders.map(
//         (order) => order.page - 1,
//       );

//       const finalIndices =
//         selectedOrders.length > 0
//           ? sortedLabelPageIndices
//           : sourcePageIndices;

//       console.log("Download selection:", {
//         invoiceMode,
//         printMode,
//         filterMode,
//         sortMode,
//         selectedOrders: selectedOrders.map((order) => ({
//           orderId: order.orderId,
//           sku: order.sku,
//           quantity: order.quantity,
//           page: order.page,
//           isMultiOrder: order.isMultiOrder,
//         })),
//         finalIndices,
//       });

//       /*
//        * AMAZON + WITH INVOICE
//        *
//        * This must run before the generic A4 branch. Otherwise the app
//        * creates a 2x2 label-only page, which was the reported issue.
//        */
//       if (isAmazon && invoiceMode === "with") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createAmazonA4WithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               )
//             : await createAmazonLabelModeWithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-invoices-a4"
//               : "amazon-labels-invoices"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * AMAZON + WITHOUT INVOICE
//        *
//        * The generic label-only branch does not know which SKU belongs to
//        * each page, so it cannot print SKU captions. Handle Amazon here
//        * using selectedOrders for All / Single / Multi filters.
//        */
//       if (isAmazon && invoiceMode === "without") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createExactA4LabelPdf({
//                 sourceBytes: pdfBytes,
//                 selectedOrders,
//                 pageIndices: finalIndices,
//                 labelWidth: A4_FOUR_UP_100MM_WIDTH_PT,
//                 labelHeight: A4_FOUR_UP_148_5MM_HEIGHT_PT,
//                 columns: 2,
//                 rows: 2,
//                 horizontalGapMm: 0,
//                 verticalGapMm: 0,
//                 showSkuCaption: true,
//               })
//             : await createExactLabelModePdf({
//                 sourceBytes: pdfBytes,
//                 selectedOrders,
//                 pageIndices: finalIndices,
//                 labelWidth: AMAZON_LABEL_WIDTH_PT,
//                 labelHeight: AMAZON_LABEL_HEIGHT_PT,
//                 showSkuCaption: true,
//               });

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-four-up-a4"
//               : "amazon-labels-100x150mm"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * FLIPKART + WITH INVOICE
//        *
//        * The source label and invoice are on the same PDF page.
//        * Use selectedOrders so SKU sorting and All/Single/Multi filtering
//        * remain correct.
//        */
//       if (isFlipkart && invoiceMode === "with") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createFlipkartA4WithInvoices(
//                 pdfBytes,
//                 selectedOrders,
//               )
//             : await createFlipkartLabelModeWithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "flipkart-labels-invoices-a4"
//               : "flipkart-labels-invoices"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * FLIPKART + WITHOUT INVOICE
//        *
//        * Labels (mm) => one 100mm x 150mm label per page.
//        * A4 Mode     => four labels per A4 page.
//        *
//        * Both modes keep SKU sorting and All/Single/Multi filtering.
//        */
//       if (isFlipkart && invoiceMode === "without") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createExactA4LabelPdf({
//                 sourceBytes: pdfBytes,
//                 selectedOrders,
//                 pageIndices: finalIndices,
//                 labelWidth: FLIPKART_LABEL_WIDTH_PT,
//                 labelHeight: FLIPKART_LABEL_HEIGHT_PT,
//                 columns: 2,
//                 rows: 2,
//                 horizontalGapMm: 10,
//                 verticalGapMm: 10,
//                 showSkuCaption: true,
//               })
//             : await createExactLabelModePdf({
//                 sourceBytes: pdfBytes,
//                 selectedOrders,
//                 pageIndices: finalIndices,
//                 labelWidth: FLIPKART_LABEL_WIDTH_PT,
//                 labelHeight: FLIPKART_LABEL_HEIGHT_PT,
//                 showSkuCaption: true,
//               });

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "flipkart-labels-75x125mm-a4"
//               : "flipkart-labels-75x125mm"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * MEESHO
//        *
//        * Labels (mm): one exact 100mm × 150mm page per label.
//        * A4 Mode: four 100mm × 148.5mm A4-fit labels per page.
//        *
//        * The existing Meesho crop changes for With/Without Invoice
//        * remain unchanged.
//        */
//       if (isMeesho) {
//         const outputBytes =
//           printMode === "a4"
//             ? await createExactA4LabelPdf({
//                 sourceBytes: pdfBytes,
//                 selectedOrders,
//                 pageIndices: finalIndices,
//                 labelWidth: A4_FOUR_UP_100MM_WIDTH_PT,
//                 labelHeight: A4_FOUR_UP_148_5MM_HEIGHT_PT,
//                 columns: 2,
//                 rows: 2,
//                 horizontalGapMm: 0,
//                 verticalGapMm: 0,
//                 showSkuCaption: false,
//               })
//             : await createExactLabelModePdf({
//                 sourceBytes: pdfBytes,
//                 selectedOrders,
//                 pageIndices: finalIndices,
//                 labelWidth: MEESHO_LABEL_WIDTH_PT,
//                 labelHeight: MEESHO_LABEL_HEIGHT_PT,
//                 showSkuCaption: false,
//               });

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "meesho-labels-four-up-a4"
//               : "meesho-labels-100x150mm"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       if (printMode === "a4") {
//         const outputDocument = await PDFDocument.create();

//         const labelsPerA4Page = isMeeshoWithInvoice ? 1 : 4;
//         const columns = isMeeshoWithInvoice ? 1 : 2;

//         const amazonLabelWidth = 283.46;
//         const amazonLabelHeight = 425.2;

//         const labelWidth = isAmazon
//           ? amazonLabelWidth
//           : isMeeshoWithInvoice
//             ? A4_WIDTH_PT
//             : A4_WIDTH_PT / columns;

//         const labelHeight = isAmazon
//           ? amazonLabelHeight
//           : labelWidth / (crop.width / crop.height);

//         const pageHeight = isMeeshoWithInvoice
//           ? labelHeight
//           : labelHeight * 2;

//         const invoiceAspect = invoiceCrop
//           ? invoiceCrop.width / invoiceCrop.height
//           : 0;

//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const invoiceWidth = A4_WIDTH_PT;
//           const invoiceHeight =
//             invoiceWidth / invoiceAspect;

//           const flipkartPageHeight =
//             labelHeight + invoiceHeight;

//           for (const pageIndex of finalIndices) {
//             const [labelPng, invoicePng] =
//               await Promise.all([
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   crop,
//                 ),
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   invoiceCrop,
//                 ),
//               ]);

//             const [embeddedLabel, embeddedInvoice] =
//               await Promise.all([
//                 outputDocument.embedPng(labelPng),
//                 outputDocument.embedPng(invoicePng),
//               ]);

//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               flipkartPageHeight,
//             ]);

//             outputPage.drawImage(embeddedLabel, {
//               x: 0,
//               y: flipkartPageHeight - labelHeight,
//               width: labelWidth,
//               height: labelHeight,
//             });

//             outputPage.drawImage(embeddedInvoice, {
//               x: 0,
//               y: 0,
//               width: invoiceWidth,
//               height: invoiceHeight,
//             });
//           }
//         } else {
//           const labelImages: Array<{
//             image: PDFImage;
//             width: number;
//             height: number;
//           }> = [];

//           for (const pageIndex of finalIndices) {
//             const pngBytes = await renderCroppedPageToPng(
//               pdfBytes,
//               pageIndex,
//               crop,
//             );

//             const embeddedPng =
//               await outputDocument.embedPng(pngBytes);

//             labelImages.push({
//               image: embeddedPng,
//               width: labelWidth,
//               height: labelHeight,
//             });
//           }

//           for (
//             let start = 0;
//             start < labelImages.length;
//             start += labelsPerA4Page
//           ) {
//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               pageHeight,
//             ]);

//             const batch = labelImages.slice(
//               start,
//               start + labelsPerA4Page,
//             );

//             batch.forEach((label, position) => {
//               const column = position % columns;
//               const row = Math.floor(position / columns);

//               const x = column * labelWidth;
//               const y =
//                 pageHeight - (row + 1) * labelHeight;

//               outputPage.drawImage(label.image, {
//                 x,
//                 y,
//                 width: label.width,
//                 height: label.height,
//               });
//             });
//           }
//         }

//         const outputBytes = await outputDocument.save();

//         downloadPdf(
//           outputBytes,
//           `labels-a4-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       const outputDocument = await PDFDocument.create();

//       for (const pageIndex of finalIndices) {
//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const labelBox = getCropBoxFromRegion(
//             crop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [labelPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           labelPage.setMediaBox(
//             labelBox.x,
//             labelBox.y,
//             labelBox.width,
//             labelBox.height,
//           );

//           outputDocument.addPage(labelPage);

//           const invoiceBox = getCropBoxFromRegion(
//             invoiceCrop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [invoicePage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           invoicePage.setMediaBox(
//             invoiceBox.x,
//             invoiceBox.y,
//             invoiceBox.width,
//             invoiceBox.height,
//           );

//           outputDocument.addPage(invoicePage);
//         } else {
//           const [copiedPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           const {
//             width: pageWidth,
//             height: pageHeight,
//           } = copiedPage.getSize();

//           const box = getCropBox(pageWidth, pageHeight);

//           copiedPage.setMediaBox(
//             box.x,
//             box.y,
//             box.width,
//             box.height,
//           );

//           outputDocument.addPage(copiedPage);
//         }
//       }

//       const outputBytes = await outputDocument.save();

//       downloadPdf(
//         outputBytes,
//         `labels-${fileName || "cropped.pdf"}`,
//       );
//     } catch (downloadError) {
//       console.error(downloadError);

//       setError(
//         downloadError instanceof Error
//           ? downloadError.message
//           : "Error cropping PDF. Please try again.",
//       );
//     } finally {
//       setProcessing(false);
//     }
//   };

//   const updateCrop = (
//     key: keyof CropRegion,
//     value: number,
//   ) => {
//     setCrop((previous) => ({
//       ...previous,
//       [key]: value,
//     }));
//   };

//   const resetCrop = () => {
//     setCrop(getEffectiveCrop());
//   };

//   const clearFile = () => {
//     setPdfBytes(null);
//     setPages([]);
//     setFileName(null);
//     setOrders([]);
//     setError(null);
//     onOrdersExtracted([]);
//   };

//   return (
//     <div className="mx-auto max-w-2xl">
//       {!pdfBytes && (
//         <div
//           {...getRootProps()}
//           className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
//             isDragActive
//               ? "border-blue-500 bg-blue-50"
//               : "border-gray-300 hover:border-blue-400"
//           } ${
//             !pdfjs || processing
//               ? "cursor-not-allowed opacity-60"
//               : ""
//           }`}
//         >
//           <input {...getInputProps()} />

//           <svg
//             className="mx-auto h-12 w-12 text-gray-400"
//             stroke="currentColor"
//             fill="none"
//             viewBox="0 0 48 48"
//             aria-hidden="true"
//           >
//             <path
//               d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
//               strokeWidth="2"
//               strokeLinecap="round"
//               strokeLinejoin="round"
//             />
//           </svg>

//           {!pdfjs ? (
//             <p className="mt-2 text-gray-600">
//               Loading PDF engine...
//             </p>
//           ) : isDragActive ? (
//             <p className="mt-2 text-blue-600">
//               Drop the PDF here...
//             </p>
//           ) : (
//             <p className="mt-2 text-gray-600">
//               Drag & drop a PDF here, or{" "}
//               <span className="font-semibold text-blue-600">
//                 browse
//               </span>
//             </p>
//           )}

//           <p className="mt-1 text-sm text-gray-500">
//             PDF files only
//           </p>
//         </div>
//       )}

//       {error && (
//         <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
//           {error}
//         </div>
//       )}

//       {fileName && pages.length > 0 && (
//         <div className="mt-4">
//           <div className="mb-4 flex items-center justify-between">
//             <div className="min-w-0">
//               <p className="text-sm text-gray-500">File</p>
//               <p className="max-w-xs truncate font-medium text-gray-800">
//                 {fileName}
//               </p>
//             </div>

//             <div className="text-right">
//               <p className="text-sm text-gray-500">Pages</p>
//               <p className="text-lg font-bold text-blue-600">
//                 {pages.length}
//               </p>
//             </div>
//           </div>

//           {orders.length > 0 && (
//             <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
//               <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
//                 <p className="text-sm font-semibold text-gray-800">
//                   Detected orders
//                 </p>
//                 <p className="mt-0.5 text-xs text-gray-500">
//                   This confirms the SKU and quantity used for
//                   sorting/filtering.
//                 </p>
//               </div>

//               <div className="max-h-52 overflow-auto">
//                 <table className="w-full text-left text-xs">
//                   <thead className="sticky top-0 bg-white text-gray-500">
//                     <tr>
//                       <th className="px-3 py-2 font-medium">
//                         Order
//                       </th>
//                       <th className="px-3 py-2 font-medium">
//                         SKU
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Qty
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Type
//                       </th>
//                     </tr>
//                   </thead>

//                   <tbody>
//                     {orders.map((order) => {
//                       const platform = String(
//                         order.platform ?? "",
//                       ).toLowerCase();

//                       const isQuantityBased =
//                         platform === "amazon" ||
//                         platform === "flipkart";

//                       const isMultiOrder = isQuantityBased
//                         ? Number(order.quantity ?? 0) > 1
//                         : Boolean(order.isMultiOrder);

//                       return (
//                         <tr
//                           key={`${order.page}-${order.orderId}-${order.sku}`}
//                           className="border-t border-gray-100"
//                         >
//                           <td className="whitespace-nowrap px-3 py-2 text-gray-700">
//                             {order.orderId || "-"}
//                           </td>
//                           <td className="px-3 py-2 font-medium text-gray-900">
//                             {order.sku || "Not detected"}
//                           </td>
//                           <td className="px-3 py-2 text-center text-gray-700">
//                             {order.quantity}
//                           </td>
//                           <td className="px-3 py-2 text-center">
//                             <span
//                               className={`rounded-full px-2 py-0.5 font-medium ${
//                                 isMultiOrder
//                                   ? "bg-amber-100 text-amber-700"
//                                   : "bg-green-100 text-green-700"
//                               }`}
//                             >
//                               {isMultiOrder
//                                 ? "Multi"
//                                 : "Single"}
//                             </span>
//                           </td>
//                         </tr>
//                       );
//                     })}
//                   </tbody>
//                 </table>
//               </div>
//             </div>
//           )}

//           <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
//             <div className="mb-3 flex items-center justify-between">
//               <p className="text-sm font-semibold text-gray-700">
//                 Adjust Crop Area
//               </p>

//               <button
//                 type="button"
//                 onClick={resetCrop}
//                 className="cursor-pointer text-xs text-gray-500 underline hover:text-gray-700"
//               >
//                 Reset to default
//               </button>
//             </div>

//             <div className="grid grid-cols-2 gap-x-4 gap-y-3">
//               <Slider
//                 label="Top"
//                 value={crop.top}
//                 onChange={(value) =>
//                   updateCrop("top", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Left"
//                 value={crop.left}
//                 onChange={(value) =>
//                   updateCrop("left", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Width"
//                 value={crop.width}
//                 onChange={(value) =>
//                   updateCrop("width", value)
//                 }
//                 min={10}
//                 max={100}
//               />

//               <Slider
//                 label="Height"
//                 value={crop.height}
//                 onChange={(value) =>
//                   updateCrop("height", value)
//                 }
//                 min={10}
//                 max={100}
//               />
//             </div>

//             <p className="mt-3 text-center text-[11px] text-gray-400">
//               Top {crop.top}% · Left {crop.left}% ·{" "}
//               {crop.width}% × {crop.height}%
//             </p>
//           </div>

//           <div className="max-h-96 space-y-4 overflow-y-auto pr-2">
//             {pages.map((page) => (
//               <div
//                 key={page.index}
//                 className="relative overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
//               >
//                 <div className="absolute left-2 top-2 z-10 rounded bg-blue-600 px-2 py-1 text-xs font-bold text-white">
//                   Page {page.index}
//                 </div>

//                 <div className="relative">
//                   {/* eslint-disable-next-line @next/next/no-img-element */}
//                   <img
//                     src={page.dataUrl}
//                     alt={`Page ${page.index}`}
//                     className="block h-auto w-full"
//                     draggable={false}
//                   />

//                   {!(
//                     isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0
//                   ) && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-green-500"
//                       style={{
//                         top: `${crop.top}%`,
//                         left: `${crop.left}%`,
//                         width: `${crop.width}%`,
//                         height: `${crop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-green-600">
//                         Label
//                       </span>
//                     </div>
//                   )}

//                   {isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0 && (
//                       <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-orange-500">
//                         <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                           Full Invoice
//                         </span>
//                       </div>
//                     )}

//                   {isFlipkartWithInvoice && invoiceCrop && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-orange-500"
//                       style={{
//                         top: `${invoiceCrop.top}%`,
//                         left: `${invoiceCrop.left}%`,
//                         width: `${invoiceCrop.width}%`,
//                         height: `${invoiceCrop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                         Invoice
//                       </span>
//                     </div>
//                   )}
//                 </div>
//               </div>
//             ))}
//           </div>

//           <div className="mt-4 flex gap-3">
//             <button
//               type="button"
//               onClick={() => void handleDownload()}
//               disabled={processing}
//               className="flex-1 cursor-pointer rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               {processing
//                 ? "Processing..."
//                 : "Download Cropped PDF"}
//             </button>

//             <button
//               type="button"
//               onClick={clearFile}
//               disabled={processing}
//               className="cursor-pointer rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               Clear
//             </button>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }

// function Slider({
//   label,
//   value,
//   onChange,
//   min,
//   max,
//   step = 0.1,
// }: {
//   label: string;
//   value: number;
//   onChange: (value: number) => void;
//   min: number;
//   max: number;
//   step?: number;
// }) {
//   return (
//     <div>
//       <div className="mb-1 flex items-center justify-between">
//         <label className="text-xs font-medium text-gray-600">
//           {label}
//         </label>

//         <span className="font-mono text-xs text-gray-500">
//           {value}%
//         </span>
//       </div>

//       <input
//         type="range"
//         min={min}
//         max={max}
//         step={step}
//         value={value}
//         onChange={(event) =>
//           onChange(Number(event.target.value))
//         }
//         className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-indigo-600"
//       />
//     </div>
//   );
// }

// "use client";

// import { useCallback, useEffect, useMemo, useState } from "react";
// import { useDropzone } from "react-dropzone";
// import {
//   PDFDocument,
//   StandardFonts,
//   type PDFImage,
//   type PDFPage,
// } from "pdf-lib";

// import type { CropConfig } from "@/lib/crop-config";
// import type { OrderData } from "@/lib/parsers/types";
// import type { SortMode, FilterMode } from "./FilterOptions";

// import { extractOrders } from "@/lib/parsers";
// import { sortOrders } from "@/lib/parsers/sort";
// import { filterOrders } from "@/lib/parsers/filter";
// import { getPlatformId } from "@/lib/platforms";

// interface PDFCropToolProps {
//   config: CropConfig;
//   printMode: "label" | "a4";
//   platformName: string;
//   invoiceMode: "with" | "without";
//   sortMode: SortMode;
//   filterMode: FilterMode;
//   onOrdersExtracted: (orders: OrderData[]) => void;
// }

// interface PageData {
//   index: number;
//   width: number;
//   height: number;
//   dataUrl: string;
// }

// interface CropRegion {
//   top: number;
//   left: number;
//   width: number;
//   height: number;
// }

// type PdfJsModule = typeof import("pdfjs-dist");

// const A4_WIDTH_PT = 595.28;
// const A4_HEIGHT_PT = 841.89;

// const FULL_PAGE_REGION: CropRegion = {
//   top: 0,
//   left: 0,
//   width: 100,
//   height: 100,
// };

// function cloneArrayBuffer(source: ArrayBuffer): ArrayBuffer {
//   const copy = new ArrayBuffer(source.byteLength);
//   new Uint8Array(copy).set(new Uint8Array(source));
//   return copy;
// }

// function downloadPdf(bytes: Uint8Array, fileName: string): void {
//   const blob = new Blob([bytes], {
//     type: "application/pdf",
//   });

//   const url = URL.createObjectURL(blob);
//   const link = document.createElement("a");

//   link.href = url;
//   link.download = fileName;
//   document.body.appendChild(link);
//   link.click();
//   link.remove();

//   window.setTimeout(() => URL.revokeObjectURL(url), 1000);
// }

// function drawImageContained(
//   page: PDFPage,
//   image: PDFImage,
//   box: {
//     x: number;
//     y: number;
//     width: number;
//     height: number;
//   },
// ): void {
//   const scale = Math.min(
//     box.width / image.width,
//     box.height / image.height,
//   );

//   const width = image.width * scale;
//   const height = image.height * scale;

//   page.drawImage(image, {
//     x: box.x + (box.width - width) / 2,
//     y: box.y + (box.height - height) / 2,
//     width,
//     height,
//   });
// }

// function shortenText(value: string, maximumLength: number): string {
//   if (value.length <= maximumLength) return value;
//   return `${value.slice(0, maximumLength - 3)}...`;
// }

// export default function PDFCropTool({
//   config,
//   printMode,
//   platformName,
//   invoiceMode,
//   sortMode,
//   filterMode,
//   onOrdersExtracted,
// }: PDFCropToolProps) {
//   const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
//   const [pages, setPages] = useState<PageData[]>([]);
//   const [fileName, setFileName] = useState<string | null>(null);
//   const [error, setError] = useState<string | null>(null);
//   const [processing, setProcessing] = useState(false);
//   const [pdfjs, setPdfjs] = useState<PdfJsModule | null>(null);
//   const [orders, setOrders] = useState<OrderData[]>([]);

//   const getEffectiveCrop = useCallback((): CropRegion => {
//     if (platformName === "Meesho" && invoiceMode === "with") {
//       return {
//         top: 1,
//         left: 2,
//         width: 97,
//         height: 78.5,
//       };
//     }

//     return config.region;
//   }, [config.region, invoiceMode, platformName]);

//   const [crop, setCrop] = useState<CropRegion>(() =>
//     getEffectiveCrop(),
//   );

//   useEffect(() => {
//     setCrop(getEffectiveCrop());
//   }, [getEffectiveCrop]);

//   useEffect(() => {
//     let active = true;

//     const loadPdfjs = async () => {
//       try {
//         const pdfJsModule = await import("pdfjs-dist");
//         pdfJsModule.GlobalWorkerOptions.workerSrc =
//           "/pdf.worker.min.mjs";

//         if (active) {
//           setPdfjs(pdfJsModule);
//         }
//       } catch (loadError) {
//         console.error(loadError);

//         if (active) {
//           setError("Could not load the PDF engine.");
//         }
//       }
//     };

//     void loadPdfjs();

//     return () => {
//       active = false;
//     };
//   }, []);

//   const isFlipkartWithInvoice =
//     platformName === "Flipkart" && invoiceMode === "with";

//   const isMeeshoWithInvoice =
//     platformName === "Meesho" && invoiceMode === "with";

//   const isAmazon = platformName === "Amazon";
//   const isFlipkart = platformName === "Flipkart";

//   const renderPages = useCallback(
//     async (bytes: ArrayBuffer): Promise<PageData[]> => {
//       if (!pdfjs) return [];

//       const doc = await pdfjs.getDocument({
//         data: cloneArrayBuffer(bytes),
//       }).promise;

//       const newPages: PageData[] = [];

//       for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
//         /*
//          * Amazon original PDF:
//          * odd PDF pages = labels
//          * even PDF pages = invoices
//          *
//          * "Without Invoice" preview should show labels only.
//          */
//         if (
//           platformName === "Amazon" &&
//           invoiceMode === "without" &&
//           pageNumber % 2 === 0
//         ) {
//           continue;
//         }

//         const page = await doc.getPage(pageNumber);
//         const viewport = page.getViewport({ scale: 1.5 });

//         const canvas = document.createElement("canvas");
//         canvas.width = Math.ceil(viewport.width);
//         canvas.height = Math.ceil(viewport.height);

//         const context = canvas.getContext("2d");

//         if (!context) {
//           throw new Error("Canvas is not available.");
//         }

//         context.fillStyle = "#ffffff";
//         context.fillRect(0, 0, canvas.width, canvas.height);

//         await page.render({
//           canvas,
//           canvasContext: context,
//           viewport,
//         }).promise;

//         newPages.push({
//           index: pageNumber,
//           width: viewport.width,
//           height: viewport.height,
//           dataUrl: canvas.toDataURL("image/png"),
//         });
//       }

//       return newPages;
//     },
//     [invoiceMode, pdfjs, platformName],
//   );

//   useEffect(() => {
//     let cancelled = false;

//     const syncPages = async () => {
//       if (!pdfBytes || !pdfjs) return;

//       try {
//         const nextPages = await renderPages(pdfBytes);

//         if (!cancelled) {
//           setPages(nextPages);
//         }
//       } catch (renderError) {
//         console.error(renderError);

//         if (!cancelled) {
//           setError("Could not refresh the PDF preview.");
//         }
//       }
//     };

//     void syncPages();

//     return () => {
//       cancelled = true;
//     };
//   }, [invoiceMode, pdfBytes, pdfjs, renderPages]);

//   const onDrop = useCallback(
//     async (acceptedFiles: File[]) => {
//       setError(null);
//       setPages([]);
//       setFileName(null);
//       setPdfBytes(null);
//       setOrders([]);
//       onOrdersExtracted([]);

//       if (acceptedFiles.length === 0) return;

//       if (!pdfjs) {
//         setError("PDF engine is still loading. Please try again.");
//         return;
//       }

//       const file = acceptedFiles[0];

//       if (
//         file.type !== "application/pdf" &&
//         !file.name.toLowerCase().endsWith(".pdf")
//       ) {
//         setError("Please upload a PDF file.");
//         return;
//       }

//       setFileName(file.name);

//       try {
//         const bytes = await file.arrayBuffer();

//         const [renderedPages, extractedOrders] = await Promise.all([
//           renderPages(bytes),
//           (async () => {
//             const platformId = getPlatformId(platformName);

//             if (!platformId) {
//               throw new Error(
//                 `Could not resolve platform: ${platformName}`,
//               );
//             }

//             return extractOrders(bytes, platformId);
//           })(),
//         ]);

//         console.log(
//           "Extracted orders:",
//           extractedOrders.map((order) => ({
//             page: order.page,
//             orderId: order.orderId,
//             sku: order.sku,
//             quantity: order.quantity,
//             isMultiOrder: order.isMultiOrder,
//           })),
//         );

//         setPdfBytes(bytes);
//         setPages(renderedPages);
//         setOrders(extractedOrders);
//         onOrdersExtracted(extractedOrders);

//         if (
//           platformName === "Amazon" &&
//           extractedOrders.length === 0
//         ) {
//           setError(
//             "No Amazon invoice data was detected. Check the browser console for parser details.",
//           );
//         }
//       } catch (dropError) {
//         console.error(dropError);
//         setError(
//           dropError instanceof Error
//             ? dropError.message
//             : "Error reading PDF. Please try again.",
//         );
//       }
//     },
//     [onOrdersExtracted, pdfjs, platformName, renderPages],
//   );

//   const { getRootProps, getInputProps, isDragActive } =
//     useDropzone({
//       onDrop,
//       accept: {
//         "application/pdf": [".pdf"],
//       },
//       maxFiles: 1,
//       multiple: false,
//       disabled: processing || !pdfjs,
//     });

//   const getCropBox = (
//     pageWidth: number,
//     pageHeight: number,
//   ) => {
//     const widthRatio = crop.width / 100;
//     const heightRatio = crop.height / 100;
//     const topOffset = crop.top / 100;
//     const leftOffset = crop.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const getCropBoxFromRegion = (
//     region: CropRegion,
//     sourceDocument: PDFDocument,
//     pageIndex: number,
//   ) => {
//     const page = sourceDocument.getPage(pageIndex);
//     const { width: pageWidth, height: pageHeight } =
//       page.getSize();

//     const widthRatio = region.width / 100;
//     const heightRatio = region.height / 100;
//     const topOffset = region.top / 100;
//     const leftOffset = region.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const invoiceCrop = config.invoiceRegion;

//   const renderCroppedPageToPng = async (
//     sourceBytes: ArrayBuffer,
//     pageIndex: number,
//     cropRegion: CropRegion = crop,
//   ): Promise<Uint8Array> => {
//     if (!pdfjs) {
//       throw new Error("PDF renderer is not ready.");
//     }

//     const scale = 2;

//     const doc = await pdfjs.getDocument({
//       data: cloneArrayBuffer(sourceBytes),
//     }).promise;

//     if (pageIndex < 0 || pageIndex >= doc.numPages) {
//       throw new Error(
//         `PDF page ${pageIndex + 1} does not exist.`,
//       );
//     }

//     const page = await doc.getPage(pageIndex + 1);
//     const viewport = page.getViewport({ scale });

//     const canvas = document.createElement("canvas");
//     canvas.width = Math.ceil(viewport.width);
//     canvas.height = Math.ceil(viewport.height);

//     const context = canvas.getContext("2d");

//     if (!context) {
//       throw new Error("Canvas is not available.");
//     }

//     context.fillStyle = "#ffffff";
//     context.fillRect(0, 0, canvas.width, canvas.height);

//     await page.render({
//       canvas,
//       canvasContext: context,
//       viewport,
//     }).promise;

//     const cropX = Math.max(
//       0,
//       Math.floor((viewport.width * cropRegion.left) / 100),
//     );

//     const cropY = Math.max(
//       0,
//       Math.floor((viewport.height * cropRegion.top) / 100),
//     );

//     const cropWidth = Math.max(
//       1,
//       Math.min(
//         canvas.width - cropX,
//         Math.floor((viewport.width * cropRegion.width) / 100),
//       ),
//     );

//     const cropHeight = Math.max(
//       1,
//       Math.min(
//         canvas.height - cropY,
//         Math.floor((viewport.height * cropRegion.height) / 100),
//       ),
//     );

//     const croppedCanvas = document.createElement("canvas");
//     croppedCanvas.width = cropWidth;
//     croppedCanvas.height = cropHeight;

//     const croppedContext = croppedCanvas.getContext("2d");

//     if (!croppedContext) {
//       throw new Error("Crop canvas is not available.");
//     }

//     croppedContext.fillStyle = "#ffffff";
//     croppedContext.fillRect(
//       0,
//       0,
//       croppedCanvas.width,
//       croppedCanvas.height,
//     );

//     croppedContext.drawImage(
//       canvas,
//       cropX,
//       cropY,
//       cropWidth,
//       cropHeight,
//       0,
//       0,
//       cropWidth,
//       cropHeight,
//     );

//     const blob = await new Promise<Blob>((resolve, reject) => {
//       croppedCanvas.toBlob((result) => {
//         if (!result) {
//           reject(new Error("Could not create cropped PDF image."));
//           return;
//         }

//         resolve(result);
//       }, "image/png");
//     });

//     return new Uint8Array(await blob.arrayBuffer());
//   };

//   const filteredAndSortedOrders = useMemo(() => {
//     const filtered = filterOrders(orders, filterMode);
//     return sortOrders(filtered, sortMode);
//   }, [filterMode, orders, sortMode]);

//   const createAmazonA4WithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const rowHeight = A4_HEIGHT_PT / 2;
//     const columnWidth = A4_WIDTH_PT / 2;
//     const captionHeight = 20;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += 2
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + 2,
//       );

//       for (let slot = 0; slot < batch.length; slot += 1) {
//         const order = batch[slot];

//         /*
//          * order.page is the one-based shipping-label page.
//          * The matching invoice is the immediately following page.
//          */
//         const labelPageIndex = order.page - 1;
//         const invoicePageIndex = labelPageIndex + 1;

//         if (
//           labelPageIndex < 0 ||
//           invoicePageIndex >= sourceDocument.getPageCount()
//         ) {
//           throw new Error(
//             `Invoice pair is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const [labelPng, invoicePng] = await Promise.all([
//           renderCroppedPageToPng(
//             sourceBytes,
//             labelPageIndex,
//             crop,
//           ),
//           renderCroppedPageToPng(
//             sourceBytes,
//             invoicePageIndex,
//             FULL_PAGE_REGION,
//           ),
//         ]);

//         const [labelImage, invoiceImage] = await Promise.all([
//           outputDocument.embedPng(labelPng),
//           outputDocument.embedPng(invoicePng),
//         ]);

//         const rowBottom =
//           A4_HEIGHT_PT - (slot + 1) * rowHeight;

//         const contentY =
//           rowBottom + captionHeight + padding;

//         const contentHeight =
//           rowHeight - captionHeight - padding * 2;

//         drawImageContained(outputPage, labelImage, {
//           x: padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         drawImageContained(outputPage, invoiceImage, {
//           x: columnWidth + padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         const displayOrderNumber = orderStart + slot + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             48,
//           ),
//           {
//             x: padding + 2,
//             y: rowBottom + 7,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         const orderCaption = `Order - ${displayOrderNumber}`;

//         outputPage.drawText(orderCaption, {
//           x: columnWidth - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });

//         outputPage.drawText(orderCaption, {
//           x: A4_WIDTH_PT - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITH invoice, label/mm mode:
//    *
//    * Output sequence:
//    * 1. Cropped label page with SKU + Qty caption
//    * 2. Matching full invoice page
//    */
//   const createAmazonLabelModeWithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = 283.46;
//     const labelHeight = 425.2;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];

//       const labelPageIndex = order.page - 1;
//       const invoicePageIndex = labelPageIndex + 1;

//       if (
//         labelPageIndex < 0 ||
//         invoicePageIndex >= sourceDocument.getPageCount()
//       ) {
//         throw new Error(
//           `Invoice pair is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       /*
//        * Render the cropped shipping label as an image so we can reserve
//        * space at the bottom for SKU and quantity.
//        */
//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         labelPageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const labelOutputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(labelOutputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       labelOutputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       labelOutputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );

//       /*
//        * Add the matching complete invoice immediately after its label.
//        */
//       const [invoicePage] =
//         await outputDocument.copyPages(
//           sourceDocument,
//           [invoicePageIndex],
//         );

//       outputDocument.addPage(invoicePage);
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITHOUT invoice, A4 mode:
//    *
//    * 4 labels per A4 page (2 columns x 2 rows).
//    * Every label gets its SKU and quantity caption.
//    */
//   const createAmazonA4WithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const columns = 2;
//     const rows = 2;
//     const labelsPerPage = columns * rows;

//     const cellWidth = A4_WIDTH_PT / columns;
//     const cellHeight = A4_HEIGHT_PT / rows;

//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += labelsPerPage
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + labelsPerPage,
//       );

//       for (
//         let position = 0;
//         position < batch.length;
//         position += 1
//       ) {
//         const order = batch[position];
//         const labelPageIndex = order.page - 1;

//         if (labelPageIndex < 0) {
//           throw new Error(
//             `Label page is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const labelPng = await renderCroppedPageToPng(
//           sourceBytes,
//           labelPageIndex,
//           crop,
//         );

//         const labelImage =
//           await outputDocument.embedPng(labelPng);

//         const column = position % columns;
//         const row = Math.floor(position / columns);

//         const cellX = column * cellWidth;
//         const cellBottom =
//           A4_HEIGHT_PT - (row + 1) * cellHeight;

//         drawImageContained(outputPage, labelImage, {
//           x: cellX + padding,
//           y: cellBottom + captionHeight + padding,
//           width: cellWidth - padding * 2,
//           height:
//             cellHeight -
//             captionHeight -
//             padding * 2,
//         });

//         const displayOrderNumber =
//           orderStart + position + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             42,
//           ),
//           {
//             x: cellX + padding + 2,
//             y: cellBottom + 8,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         outputPage.drawText(
//           `Order - ${displayOrderNumber}`,
//           {
//             x: cellX + cellWidth - 58,
//             y: cellBottom + 8,
//             size: 7,
//             font: regularFont,
//           },
//         );
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITHOUT invoice, label/mm mode:
//    *
//    * One 100 mm x 150 mm output page per label.
//    * SKU and quantity are printed at the bottom of every page.
//    */
//   const createAmazonLabelModeWithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = 283.46;
//     const labelHeight = 425.2;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const labelPageIndex = order.page - 1;

//       if (labelPageIndex < 0) {
//         throw new Error(
//           `Label page is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         labelPageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const outputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(outputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       outputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       outputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Flipkart WITH invoice, A4 mode.
//    *
//    * Each source page contains both the shipping label and invoice.
//    * The output keeps one order per A4 page and adds SKU + Qty between
//    * the label and invoice.
//    */
//   const createFlipkartA4WithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     if (!invoiceCrop) {
//       throw new Error(
//         "Flipkart invoice crop region is not configured.",
//       );
//     }

//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const margin = 8;
//     const captionHeight = 22;
//     const gap = 5;

//     const contentHeight =
//       A4_HEIGHT_PT -
//       margin * 2 -
//       captionHeight -
//       gap;

//     const labelAreaHeight = contentHeight * 0.42;
//     const invoiceAreaHeight =
//       contentHeight - labelAreaHeight;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const pageIndex = order.page - 1;

//       const [labelPng, invoicePng] = await Promise.all([
//         renderCroppedPageToPng(
//           sourceBytes,
//           pageIndex,
//           crop,
//         ),
//         renderCroppedPageToPng(
//           sourceBytes,
//           pageIndex,
//           invoiceCrop,
//         ),
//       ]);

//       const [labelImage, invoiceImage] =
//         await Promise.all([
//           outputDocument.embedPng(labelPng),
//           outputDocument.embedPng(invoicePng),
//         ]);

//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       drawImageContained(outputPage, invoiceImage, {
//         x: margin,
//         y: margin,
//         width: A4_WIDTH_PT - margin * 2,
//         height: invoiceAreaHeight,
//       });

//       const captionY =
//         margin + invoiceAreaHeight + 7;

//       outputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           65,
//         ),
//         {
//           x: margin + 3,
//           y: captionY,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       outputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: A4_WIDTH_PT - 67,
//           y: captionY,
//           size: 8,
//           font: regularFont,
//         },
//       );

//       drawImageContained(outputPage, labelImage, {
//         x: margin,
//         y:
//           margin +
//           invoiceAreaHeight +
//           captionHeight +
//           gap,
//         width: A4_WIDTH_PT - margin * 2,
//         height: labelAreaHeight,
//       });
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Flipkart WITH invoice, label/mm mode.
//    *
//    * Output sequence:
//    * 1. 100mm x 150mm label page with SKU + Qty
//    * 2. Matching cropped invoice page
//    */
//   const createFlipkartLabelModeWithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     if (!invoiceCrop) {
//       throw new Error(
//         "Flipkart invoice crop region is not configured.",
//       );
//     }

//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = 283.46;
//     const labelHeight = 425.2;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const pageIndex = order.page - 1;

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         pageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const labelPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(labelPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       labelPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       labelPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );

//       const invoiceBox = getCropBoxFromRegion(
//         invoiceCrop,
//         sourceDocument,
//         pageIndex,
//       );

//       const [invoicePage] =
//         await outputDocument.copyPages(
//           sourceDocument,
//           [pageIndex],
//         );

//       invoicePage.setMediaBox(
//         invoiceBox.x,
//         invoiceBox.y,
//         invoiceBox.width,
//         invoiceBox.height,
//       );

//       outputDocument.addPage(invoicePage);
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Flipkart WITHOUT invoice, label/mm mode.
//    *
//    * A4 is disabled in page.tsx for this mode.
//    * Every label still displays SKU + Qty and respects the selected filter.
//    */
//   const createFlipkartLabelModeWithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = 283.46;
//     const labelHeight = 425.2;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const pageIndex = order.page - 1;

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         pageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const outputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(outputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       outputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       outputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );
//     }

//     return outputDocument.save();
//   };

//   const handleDownload = async () => {
//     if (!pdfBytes || pages.length === 0) return;

//     setProcessing(true);
//     setError(null);

//     try {
//       const sourceDocument = await PDFDocument.load(
//         cloneArrayBuffer(pdfBytes),
//       );

//       let sourcePageIndices = sourceDocument.getPageIndices();

//       if (isAmazon && invoiceMode === "without") {
//         sourcePageIndices = sourcePageIndices.filter(
//           (pageIndex) => pageIndex % 2 === 0,
//         );
//       }

//       if (isAmazon && orders.length === 0) {
//         throw new Error(
//           "Amazon order data was not detected. OCR is not required for this PDF; verify that amazon.ts is replaced with the updated parser.",
//         );
//       }

//       if (isFlipkart && orders.length === 0) {
//         throw new Error(
//           "Flipkart order data was not detected. Verify that flipkart.ts is replaced with the updated parser.",
//         );
//       }

//       if (orders.length === 0 && filterMode !== "all") {
//         throw new Error(
//           "Could not detect single/multi order details. Use All Orders or verify the parser output.",
//         );
//       }

//       const selectedOrders = filteredAndSortedOrders;

//       if (
//         filterMode !== "all" &&
//         selectedOrders.length === 0
//       ) {
//         throw new Error(
//           `No ${
//             filterMode === "single" ? "single" : "multi"
//           } orders were detected in this PDF.`,
//         );
//       }

//       const sortedLabelPageIndices = selectedOrders.map(
//         (order) => order.page - 1,
//       );

//       const finalIndices =
//         selectedOrders.length > 0
//           ? sortedLabelPageIndices
//           : sourcePageIndices;

//       console.log("Download selection:", {
//         invoiceMode,
//         printMode,
//         filterMode,
//         sortMode,
//         selectedOrders: selectedOrders.map((order) => ({
//           orderId: order.orderId,
//           sku: order.sku,
//           quantity: order.quantity,
//           page: order.page,
//           isMultiOrder: order.isMultiOrder,
//         })),
//         finalIndices,
//       });

//       /*
//        * AMAZON + WITH INVOICE
//        *
//        * This must run before the generic A4 branch. Otherwise the app
//        * creates a 2x2 label-only page, which was the reported issue.
//        */
//       if (isAmazon && invoiceMode === "with") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createAmazonA4WithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               )
//             : await createAmazonLabelModeWithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-invoices-a4"
//               : "amazon-labels-invoices"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * AMAZON + WITHOUT INVOICE
//        *
//        * The generic label-only branch does not know which SKU belongs to
//        * each page, so it cannot print SKU captions. Handle Amazon here
//        * using selectedOrders for All / Single / Multi filters.
//        */
//       if (isAmazon && invoiceMode === "without") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createAmazonA4WithoutInvoices(
//                 pdfBytes,
//                 selectedOrders,
//               )
//             : await createAmazonLabelModeWithoutInvoices(
//                 pdfBytes,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-with-sku-a4"
//               : "amazon-labels-with-sku"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * FLIPKART + WITH INVOICE
//        *
//        * The source label and invoice are on the same PDF page.
//        * Use selectedOrders so SKU sorting and All/Single/Multi filtering
//        * remain correct.
//        */
//       if (isFlipkart && invoiceMode === "with") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createFlipkartA4WithInvoices(
//                 pdfBytes,
//                 selectedOrders,
//               )
//             : await createFlipkartLabelModeWithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "flipkart-labels-invoices-a4"
//               : "flipkart-labels-invoices"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * FLIPKART + WITHOUT INVOICE
//        *
//        * page.tsx forces Labels (mm) and disables A4.
//        * This guard also keeps the output correct if stale UI state sends a4.
//        */
//       if (isFlipkart && invoiceMode === "without") {
//         const outputBytes =
//           await createFlipkartLabelModeWithoutInvoices(
//             pdfBytes,
//             selectedOrders,
//           );

//         downloadPdf(
//           outputBytes,
//           `flipkart-labels-with-sku-${
//             fileName || "cropped.pdf"
//           }`,
//         );

//         return;
//       }

//       if (printMode === "a4") {
//         const outputDocument = await PDFDocument.create();

//         const labelsPerA4Page = isMeeshoWithInvoice ? 1 : 4;
//         const columns = isMeeshoWithInvoice ? 1 : 2;

//         const amazonLabelWidth = 283.46;
//         const amazonLabelHeight = 425.2;

//         const labelWidth = isAmazon
//           ? amazonLabelWidth
//           : isMeeshoWithInvoice
//             ? A4_WIDTH_PT
//             : A4_WIDTH_PT / columns;

//         const labelHeight = isAmazon
//           ? amazonLabelHeight
//           : labelWidth / (crop.width / crop.height);

//         const pageHeight = isMeeshoWithInvoice
//           ? labelHeight
//           : labelHeight * 2;

//         const invoiceAspect = invoiceCrop
//           ? invoiceCrop.width / invoiceCrop.height
//           : 0;

//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const invoiceWidth = A4_WIDTH_PT;
//           const invoiceHeight =
//             invoiceWidth / invoiceAspect;

//           const flipkartPageHeight =
//             labelHeight + invoiceHeight;

//           for (const pageIndex of finalIndices) {
//             const [labelPng, invoicePng] =
//               await Promise.all([
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   crop,
//                 ),
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   invoiceCrop,
//                 ),
//               ]);

//             const [embeddedLabel, embeddedInvoice] =
//               await Promise.all([
//                 outputDocument.embedPng(labelPng),
//                 outputDocument.embedPng(invoicePng),
//               ]);

//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               flipkartPageHeight,
//             ]);

//             outputPage.drawImage(embeddedLabel, {
//               x: 0,
//               y: flipkartPageHeight - labelHeight,
//               width: labelWidth,
//               height: labelHeight,
//             });

//             outputPage.drawImage(embeddedInvoice, {
//               x: 0,
//               y: 0,
//               width: invoiceWidth,
//               height: invoiceHeight,
//             });
//           }
//         } else {
//           const labelImages: Array<{
//             image: PDFImage;
//             width: number;
//             height: number;
//           }> = [];

//           for (const pageIndex of finalIndices) {
//             const pngBytes = await renderCroppedPageToPng(
//               pdfBytes,
//               pageIndex,
//               crop,
//             );

//             const embeddedPng =
//               await outputDocument.embedPng(pngBytes);

//             labelImages.push({
//               image: embeddedPng,
//               width: labelWidth,
//               height: labelHeight,
//             });
//           }

//           for (
//             let start = 0;
//             start < labelImages.length;
//             start += labelsPerA4Page
//           ) {
//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               pageHeight,
//             ]);

//             const batch = labelImages.slice(
//               start,
//               start + labelsPerA4Page,
//             );

//             batch.forEach((label, position) => {
//               const column = position % columns;
//               const row = Math.floor(position / columns);

//               const x = column * labelWidth;
//               const y =
//                 pageHeight - (row + 1) * labelHeight;

//               outputPage.drawImage(label.image, {
//                 x,
//                 y,
//                 width: label.width,
//                 height: label.height,
//               });
//             });
//           }
//         }

//         const outputBytes = await outputDocument.save();

//         downloadPdf(
//           outputBytes,
//           `labels-a4-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       const outputDocument = await PDFDocument.create();

//       for (const pageIndex of finalIndices) {
//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const labelBox = getCropBoxFromRegion(
//             crop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [labelPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           labelPage.setMediaBox(
//             labelBox.x,
//             labelBox.y,
//             labelBox.width,
//             labelBox.height,
//           );

//           outputDocument.addPage(labelPage);

//           const invoiceBox = getCropBoxFromRegion(
//             invoiceCrop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [invoicePage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           invoicePage.setMediaBox(
//             invoiceBox.x,
//             invoiceBox.y,
//             invoiceBox.width,
//             invoiceBox.height,
//           );

//           outputDocument.addPage(invoicePage);
//         } else {
//           const [copiedPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           const {
//             width: pageWidth,
//             height: pageHeight,
//           } = copiedPage.getSize();

//           const box = getCropBox(pageWidth, pageHeight);

//           copiedPage.setMediaBox(
//             box.x,
//             box.y,
//             box.width,
//             box.height,
//           );

//           outputDocument.addPage(copiedPage);
//         }
//       }

//       const outputBytes = await outputDocument.save();

//       downloadPdf(
//         outputBytes,
//         `labels-${fileName || "cropped.pdf"}`,
//       );
//     } catch (downloadError) {
//       console.error(downloadError);

//       setError(
//         downloadError instanceof Error
//           ? downloadError.message
//           : "Error cropping PDF. Please try again.",
//       );
//     } finally {
//       setProcessing(false);
//     }
//   };

//   const updateCrop = (
//     key: keyof CropRegion,
//     value: number,
//   ) => {
//     setCrop((previous) => ({
//       ...previous,
//       [key]: value,
//     }));
//   };

//   const resetCrop = () => {
//     setCrop(getEffectiveCrop());
//   };

//   const clearFile = () => {
//     setPdfBytes(null);
//     setPages([]);
//     setFileName(null);
//     setOrders([]);
//     setError(null);
//     onOrdersExtracted([]);
//   };

//   return (
//     <div className="mx-auto max-w-2xl">
//       {!pdfBytes && (
//         <div
//           {...getRootProps()}
//           className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
//             isDragActive
//               ? "border-blue-500 bg-blue-50"
//               : "border-gray-300 hover:border-blue-400"
//           } ${
//             !pdfjs || processing
//               ? "cursor-not-allowed opacity-60"
//               : ""
//           }`}
//         >
//           <input {...getInputProps()} />

//           <svg
//             className="mx-auto h-12 w-12 text-gray-400"
//             stroke="currentColor"
//             fill="none"
//             viewBox="0 0 48 48"
//             aria-hidden="true"
//           >
//             <path
//               d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
//               strokeWidth="2"
//               strokeLinecap="round"
//               strokeLinejoin="round"
//             />
//           </svg>

//           {!pdfjs ? (
//             <p className="mt-2 text-gray-600">
//               Loading PDF engine...
//             </p>
//           ) : isDragActive ? (
//             <p className="mt-2 text-blue-600">
//               Drop the PDF here...
//             </p>
//           ) : (
//             <p className="mt-2 text-gray-600">
//               Drag & drop a PDF here, or{" "}
//               <span className="font-semibold text-blue-600">
//                 browse
//               </span>
//             </p>
//           )}

//           <p className="mt-1 text-sm text-gray-500">
//             PDF files only
//           </p>
//         </div>
//       )}

//       {error && (
//         <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
//           {error}
//         </div>
//       )}

//       {fileName && pages.length > 0 && (
//         <div className="mt-4">
//           <div className="mb-4 flex items-center justify-between">
//             <div className="min-w-0">
//               <p className="text-sm text-gray-500">File</p>
//               <p className="max-w-xs truncate font-medium text-gray-800">
//                 {fileName}
//               </p>
//             </div>

//             <div className="text-right">
//               <p className="text-sm text-gray-500">Pages</p>
//               <p className="text-lg font-bold text-blue-600">
//                 {pages.length}
//               </p>
//             </div>
//           </div>

//           {orders.length > 0 && (
//             <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
//               <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
//                 <p className="text-sm font-semibold text-gray-800">
//                   Detected orders
//                 </p>
//                 <p className="mt-0.5 text-xs text-gray-500">
//                   This confirms the SKU and quantity used for
//                   sorting/filtering.
//                 </p>
//               </div>

//               <div className="max-h-52 overflow-auto">
//                 <table className="w-full text-left text-xs">
//                   <thead className="sticky top-0 bg-white text-gray-500">
//                     <tr>
//                       <th className="px-3 py-2 font-medium">
//                         Order
//                       </th>
//                       <th className="px-3 py-2 font-medium">
//                         SKU
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Qty
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Type
//                       </th>
//                     </tr>
//                   </thead>

//                   <tbody>
//                     {orders.map((order) => {
//                       const platform = String(
//                         order.platform ?? "",
//                       ).toLowerCase();

//                       const isQuantityBased =
//                         platform === "amazon" ||
//                         platform === "flipkart";

//                       const isMultiOrder = isQuantityBased
//                         ? Number(order.quantity ?? 0) > 1
//                         : Boolean(order.isMultiOrder);

//                       return (
//                         <tr
//                           key={`${order.page}-${order.orderId}-${order.sku}`}
//                           className="border-t border-gray-100"
//                         >
//                           <td className="whitespace-nowrap px-3 py-2 text-gray-700">
//                             {order.orderId || "-"}
//                           </td>
//                           <td className="px-3 py-2 font-medium text-gray-900">
//                             {order.sku || "Not detected"}
//                           </td>
//                           <td className="px-3 py-2 text-center text-gray-700">
//                             {order.quantity}
//                           </td>
//                           <td className="px-3 py-2 text-center">
//                             <span
//                               className={`rounded-full px-2 py-0.5 font-medium ${
//                                 isMultiOrder
//                                   ? "bg-amber-100 text-amber-700"
//                                   : "bg-green-100 text-green-700"
//                               }`}
//                             >
//                               {isMultiOrder
//                                 ? "Multi"
//                                 : "Single"}
//                             </span>
//                           </td>
//                         </tr>
//                       );
//                     })}
//                   </tbody>
//                 </table>
//               </div>
//             </div>
//           )}

//           <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
//             <div className="mb-3 flex items-center justify-between">
//               <p className="text-sm font-semibold text-gray-700">
//                 Adjust Crop Area
//               </p>

//               <button
//                 type="button"
//                 onClick={resetCrop}
//                 className="cursor-pointer text-xs text-gray-500 underline hover:text-gray-700"
//               >
//                 Reset to default
//               </button>
//             </div>

//             <div className="grid grid-cols-2 gap-x-4 gap-y-3">
//               <Slider
//                 label="Top"
//                 value={crop.top}
//                 onChange={(value) =>
//                   updateCrop("top", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Left"
//                 value={crop.left}
//                 onChange={(value) =>
//                   updateCrop("left", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Width"
//                 value={crop.width}
//                 onChange={(value) =>
//                   updateCrop("width", value)
//                 }
//                 min={10}
//                 max={100}
//               />

//               <Slider
//                 label="Height"
//                 value={crop.height}
//                 onChange={(value) =>
//                   updateCrop("height", value)
//                 }
//                 min={10}
//                 max={100}
//               />
//             </div>

//             <p className="mt-3 text-center text-[11px] text-gray-400">
//               Top {crop.top}% · Left {crop.left}% ·{" "}
//               {crop.width}% × {crop.height}%
//             </p>
//           </div>

//           <div className="max-h-96 space-y-4 overflow-y-auto pr-2">
//             {pages.map((page) => (
//               <div
//                 key={page.index}
//                 className="relative overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
//               >
//                 <div className="absolute left-2 top-2 z-10 rounded bg-blue-600 px-2 py-1 text-xs font-bold text-white">
//                   Page {page.index}
//                 </div>

//                 <div className="relative">
//                   {/* eslint-disable-next-line @next/next/no-img-element */}
//                   <img
//                     src={page.dataUrl}
//                     alt={`Page ${page.index}`}
//                     className="block h-auto w-full"
//                     draggable={false}
//                   />

//                   {!(
//                     isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0
//                   ) && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-green-500"
//                       style={{
//                         top: `${crop.top}%`,
//                         left: `${crop.left}%`,
//                         width: `${crop.width}%`,
//                         height: `${crop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-green-600">
//                         Label
//                       </span>
//                     </div>
//                   )}

//                   {isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0 && (
//                       <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-orange-500">
//                         <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                           Full Invoice
//                         </span>
//                       </div>
//                     )}

//                   {isFlipkartWithInvoice && invoiceCrop && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-orange-500"
//                       style={{
//                         top: `${invoiceCrop.top}%`,
//                         left: `${invoiceCrop.left}%`,
//                         width: `${invoiceCrop.width}%`,
//                         height: `${invoiceCrop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                         Invoice
//                       </span>
//                     </div>
//                   )}
//                 </div>
//               </div>
//             ))}
//           </div>

//           <div className="mt-4 flex gap-3">
//             <button
//               type="button"
//               onClick={() => void handleDownload()}
//               disabled={processing}
//               className="flex-1 cursor-pointer rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               {processing
//                 ? "Processing..."
//                 : "Download Cropped PDF"}
//             </button>

//             <button
//               type="button"
//               onClick={clearFile}
//               disabled={processing}
//               className="cursor-pointer rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               Clear
//             </button>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }

// function Slider({
//   label,
//   value,
//   onChange,
//   min,
//   max,
//   step = 0.1,
// }: {
//   label: string;
//   value: number;
//   onChange: (value: number) => void;
//   min: number;
//   max: number;
//   step?: number;
// }) {
//   return (
//     <div>
//       <div className="mb-1 flex items-center justify-between">
//         <label className="text-xs font-medium text-gray-600">
//           {label}
//         </label>

//         <span className="font-mono text-xs text-gray-500">
//           {value}%
//         </span>
//       </div>

//       <input
//         type="range"
//         min={min}
//         max={max}
//         step={step}
//         value={value}
//         onChange={(event) =>
//           onChange(Number(event.target.value))
//         }
//         className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-indigo-600"
//       />
//     </div>
//   );
// }

// "use client";

// import { useCallback, useEffect, useMemo, useState } from "react";
// import { useDropzone } from "react-dropzone";
// import {
//   PDFDocument,
//   StandardFonts,
//   type PDFImage,
//   type PDFPage,
// } from "pdf-lib";

// import type { CropConfig } from "@/lib/crop-config";
// import type { OrderData } from "@/lib/parsers/types";
// import type { SortMode, FilterMode } from "./FilterOptions";

// import { extractOrders } from "@/lib/parsers";
// import { sortOrders } from "@/lib/parsers/sort";
// import { filterOrders } from "@/lib/parsers/filter";
// import { getPlatformId } from "@/lib/platforms";

// interface PDFCropToolProps {
//   config: CropConfig;
//   printMode: "label" | "a4";
//   platformName: string;
//   invoiceMode: "with" | "without";
//   sortMode: SortMode;
//   filterMode: FilterMode;
//   onOrdersExtracted: (orders: OrderData[]) => void;
// }

// interface PageData {
//   index: number;
//   width: number;
//   height: number;
//   dataUrl: string;
// }

// interface CropRegion {
//   top: number;
//   left: number;
//   width: number;
//   height: number;
// }

// type PdfJsModule = typeof import("pdfjs-dist");

// const A4_WIDTH_PT = 595.28;
// const A4_HEIGHT_PT = 841.89;

// const FULL_PAGE_REGION: CropRegion = {
//   top: 0,
//   left: 0,
//   width: 100,
//   height: 100,
// };

// function cloneArrayBuffer(source: ArrayBuffer): ArrayBuffer {
//   const copy = new ArrayBuffer(source.byteLength);
//   new Uint8Array(copy).set(new Uint8Array(source));
//   return copy;
// }

// function downloadPdf(bytes: Uint8Array, fileName: string): void {
//   const blob = new Blob([bytes], {
//     type: "application/pdf",
//   });

//   const url = URL.createObjectURL(blob);
//   const link = document.createElement("a");

//   link.href = url;
//   link.download = fileName;
//   document.body.appendChild(link);
//   link.click();
//   link.remove();

//   window.setTimeout(() => URL.revokeObjectURL(url), 1000);
// }

// function drawImageContained(
//   page: PDFPage,
//   image: PDFImage,
//   box: {
//     x: number;
//     y: number;
//     width: number;
//     height: number;
//   },
// ): void {
//   const scale = Math.min(
//     box.width / image.width,
//     box.height / image.height,
//   );

//   const width = image.width * scale;
//   const height = image.height * scale;

//   page.drawImage(image, {
//     x: box.x + (box.width - width) / 2,
//     y: box.y + (box.height - height) / 2,
//     width,
//     height,
//   });
// }

// function shortenText(value: string, maximumLength: number): string {
//   if (value.length <= maximumLength) return value;
//   return `${value.slice(0, maximumLength - 3)}...`;
// }

// export default function PDFCropTool({
//   config,
//   printMode,
//   platformName,
//   invoiceMode,
//   sortMode,
//   filterMode,
//   onOrdersExtracted,
// }: PDFCropToolProps) {
//   const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
//   const [pages, setPages] = useState<PageData[]>([]);
//   const [fileName, setFileName] = useState<string | null>(null);
//   const [error, setError] = useState<string | null>(null);
//   const [processing, setProcessing] = useState(false);
//   const [pdfjs, setPdfjs] = useState<PdfJsModule | null>(null);
//   const [orders, setOrders] = useState<OrderData[]>([]);

//   const getEffectiveCrop = useCallback((): CropRegion => {
//     if (platformName === "Meesho" && invoiceMode === "with") {
//       return {
//         top: 1,
//         left: 2,
//         width: 97,
//         height: 78.5,
//       };
//     }

//     return config.region;
//   }, [config.region, invoiceMode, platformName]);

//   const [crop, setCrop] = useState<CropRegion>(() =>
//     getEffectiveCrop(),
//   );

//   useEffect(() => {
//     setCrop(getEffectiveCrop());
//   }, [getEffectiveCrop]);

//   useEffect(() => {
//     let active = true;

//     const loadPdfjs = async () => {
//       try {
//         const pdfJsModule = await import("pdfjs-dist");
//         pdfJsModule.GlobalWorkerOptions.workerSrc =
//           "/pdf.worker.min.mjs";

//         if (active) {
//           setPdfjs(pdfJsModule);
//         }
//       } catch (loadError) {
//         console.error(loadError);

//         if (active) {
//           setError("Could not load the PDF engine.");
//         }
//       }
//     };

//     void loadPdfjs();

//     return () => {
//       active = false;
//     };
//   }, []);

//   const isFlipkartWithInvoice =
//     platformName === "Flipkart" && invoiceMode === "with";

//   const isMeeshoWithInvoice =
//     platformName === "Meesho" && invoiceMode === "with";

//   const isAmazon = platformName === "Amazon";

//   const renderPages = useCallback(
//     async (bytes: ArrayBuffer): Promise<PageData[]> => {
//       if (!pdfjs) return [];

//       const doc = await pdfjs.getDocument({
//         data: cloneArrayBuffer(bytes),
//       }).promise;

//       const newPages: PageData[] = [];

//       for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
//         /*
//          * Amazon original PDF:
//          * odd PDF pages = labels
//          * even PDF pages = invoices
//          *
//          * "Without Invoice" preview should show labels only.
//          */
//         if (
//           platformName === "Amazon" &&
//           invoiceMode === "without" &&
//           pageNumber % 2 === 0
//         ) {
//           continue;
//         }

//         const page = await doc.getPage(pageNumber);
//         const viewport = page.getViewport({ scale: 1.5 });

//         const canvas = document.createElement("canvas");
//         canvas.width = Math.ceil(viewport.width);
//         canvas.height = Math.ceil(viewport.height);

//         const context = canvas.getContext("2d");

//         if (!context) {
//           throw new Error("Canvas is not available.");
//         }

//         context.fillStyle = "#ffffff";
//         context.fillRect(0, 0, canvas.width, canvas.height);

//         await page.render({
//           canvas,
//           canvasContext: context,
//           viewport,
//         }).promise;

//         newPages.push({
//           index: pageNumber,
//           width: viewport.width,
//           height: viewport.height,
//           dataUrl: canvas.toDataURL("image/png"),
//         });
//       }

//       return newPages;
//     },
//     [invoiceMode, pdfjs, platformName],
//   );

//   useEffect(() => {
//     let cancelled = false;

//     const syncPages = async () => {
//       if (!pdfBytes || !pdfjs) return;

//       try {
//         const nextPages = await renderPages(pdfBytes);

//         if (!cancelled) {
//           setPages(nextPages);
//         }
//       } catch (renderError) {
//         console.error(renderError);

//         if (!cancelled) {
//           setError("Could not refresh the PDF preview.");
//         }
//       }
//     };

//     void syncPages();

//     return () => {
//       cancelled = true;
//     };
//   }, [invoiceMode, pdfBytes, pdfjs, renderPages]);

//   const onDrop = useCallback(
//     async (acceptedFiles: File[]) => {
//       setError(null);
//       setPages([]);
//       setFileName(null);
//       setPdfBytes(null);
//       setOrders([]);
//       onOrdersExtracted([]);

//       if (acceptedFiles.length === 0) return;

//       if (!pdfjs) {
//         setError("PDF engine is still loading. Please try again.");
//         return;
//       }

//       const file = acceptedFiles[0];

//       if (
//         file.type !== "application/pdf" &&
//         !file.name.toLowerCase().endsWith(".pdf")
//       ) {
//         setError("Please upload a PDF file.");
//         return;
//       }

//       setFileName(file.name);

//       try {
//         const bytes = await file.arrayBuffer();

//         const [renderedPages, extractedOrders] = await Promise.all([
//           renderPages(bytes),
//           (async () => {
//             const platformId = getPlatformId(platformName);

//             if (!platformId) {
//               throw new Error(
//                 `Could not resolve platform: ${platformName}`,
//               );
//             }

//             return extractOrders(bytes, platformId);
//           })(),
//         ]);

//         console.log(
//           "Extracted orders:",
//           extractedOrders.map((order) => ({
//             page: order.page,
//             orderId: order.orderId,
//             sku: order.sku,
//             quantity: order.quantity,
//             isMultiOrder: order.isMultiOrder,
//           })),
//         );

//         setPdfBytes(bytes);
//         setPages(renderedPages);
//         setOrders(extractedOrders);
//         onOrdersExtracted(extractedOrders);

//         if (
//           platformName === "Amazon" &&
//           extractedOrders.length === 0
//         ) {
//           setError(
//             "No Amazon invoice data was detected. Check the browser console for parser details.",
//           );
//         }
//       } catch (dropError) {
//         console.error(dropError);
//         setError(
//           dropError instanceof Error
//             ? dropError.message
//             : "Error reading PDF. Please try again.",
//         );
//       }
//     },
//     [onOrdersExtracted, pdfjs, platformName, renderPages],
//   );

//   const { getRootProps, getInputProps, isDragActive } =
//     useDropzone({
//       onDrop,
//       accept: {
//         "application/pdf": [".pdf"],
//       },
//       maxFiles: 1,
//       multiple: false,
//       disabled: processing || !pdfjs,
//     });

//   const getCropBox = (
//     pageWidth: number,
//     pageHeight: number,
//   ) => {
//     const widthRatio = crop.width / 100;
//     const heightRatio = crop.height / 100;
//     const topOffset = crop.top / 100;
//     const leftOffset = crop.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const getCropBoxFromRegion = (
//     region: CropRegion,
//     sourceDocument: PDFDocument,
//     pageIndex: number,
//   ) => {
//     const page = sourceDocument.getPage(pageIndex);
//     const { width: pageWidth, height: pageHeight } =
//       page.getSize();

//     const widthRatio = region.width / 100;
//     const heightRatio = region.height / 100;
//     const topOffset = region.top / 100;
//     const leftOffset = region.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const invoiceCrop = config.invoiceRegion;

//   const renderCroppedPageToPng = async (
//     sourceBytes: ArrayBuffer,
//     pageIndex: number,
//     cropRegion: CropRegion = crop,
//   ): Promise<Uint8Array> => {
//     if (!pdfjs) {
//       throw new Error("PDF renderer is not ready.");
//     }

//     const scale = 2;

//     const doc = await pdfjs.getDocument({
//       data: cloneArrayBuffer(sourceBytes),
//     }).promise;

//     if (pageIndex < 0 || pageIndex >= doc.numPages) {
//       throw new Error(
//         `PDF page ${pageIndex + 1} does not exist.`,
//       );
//     }

//     const page = await doc.getPage(pageIndex + 1);
//     const viewport = page.getViewport({ scale });

//     const canvas = document.createElement("canvas");
//     canvas.width = Math.ceil(viewport.width);
//     canvas.height = Math.ceil(viewport.height);

//     const context = canvas.getContext("2d");

//     if (!context) {
//       throw new Error("Canvas is not available.");
//     }

//     context.fillStyle = "#ffffff";
//     context.fillRect(0, 0, canvas.width, canvas.height);

//     await page.render({
//       canvas,
//       canvasContext: context,
//       viewport,
//     }).promise;

//     const cropX = Math.max(
//       0,
//       Math.floor((viewport.width * cropRegion.left) / 100),
//     );

//     const cropY = Math.max(
//       0,
//       Math.floor((viewport.height * cropRegion.top) / 100),
//     );

//     const cropWidth = Math.max(
//       1,
//       Math.min(
//         canvas.width - cropX,
//         Math.floor((viewport.width * cropRegion.width) / 100),
//       ),
//     );

//     const cropHeight = Math.max(
//       1,
//       Math.min(
//         canvas.height - cropY,
//         Math.floor((viewport.height * cropRegion.height) / 100),
//       ),
//     );

//     const croppedCanvas = document.createElement("canvas");
//     croppedCanvas.width = cropWidth;
//     croppedCanvas.height = cropHeight;

//     const croppedContext = croppedCanvas.getContext("2d");

//     if (!croppedContext) {
//       throw new Error("Crop canvas is not available.");
//     }

//     croppedContext.fillStyle = "#ffffff";
//     croppedContext.fillRect(
//       0,
//       0,
//       croppedCanvas.width,
//       croppedCanvas.height,
//     );

//     croppedContext.drawImage(
//       canvas,
//       cropX,
//       cropY,
//       cropWidth,
//       cropHeight,
//       0,
//       0,
//       cropWidth,
//       cropHeight,
//     );

//     const blob = await new Promise<Blob>((resolve, reject) => {
//       croppedCanvas.toBlob((result) => {
//         if (!result) {
//           reject(new Error("Could not create cropped PDF image."));
//           return;
//         }

//         resolve(result);
//       }, "image/png");
//     });

//     return new Uint8Array(await blob.arrayBuffer());
//   };

//   const filteredAndSortedOrders = useMemo(() => {
//     const filtered = filterOrders(orders, filterMode);
//     return sortOrders(filtered, sortMode);
//   }, [filterMode, orders, sortMode]);

//   const createAmazonA4WithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const rowHeight = A4_HEIGHT_PT / 2;
//     const columnWidth = A4_WIDTH_PT / 2;
//     const captionHeight = 20;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += 2
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + 2,
//       );

//       for (let slot = 0; slot < batch.length; slot += 1) {
//         const order = batch[slot];

//         /*
//          * order.page is the one-based shipping-label page.
//          * The matching invoice is the immediately following page.
//          */
//         const labelPageIndex = order.page - 1;
//         const invoicePageIndex = labelPageIndex + 1;

//         if (
//           labelPageIndex < 0 ||
//           invoicePageIndex >= sourceDocument.getPageCount()
//         ) {
//           throw new Error(
//             `Invoice pair is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const [labelPng, invoicePng] = await Promise.all([
//           renderCroppedPageToPng(
//             sourceBytes,
//             labelPageIndex,
//             crop,
//           ),
//           renderCroppedPageToPng(
//             sourceBytes,
//             invoicePageIndex,
//             FULL_PAGE_REGION,
//           ),
//         ]);

//         const [labelImage, invoiceImage] = await Promise.all([
//           outputDocument.embedPng(labelPng),
//           outputDocument.embedPng(invoicePng),
//         ]);

//         const rowBottom =
//           A4_HEIGHT_PT - (slot + 1) * rowHeight;

//         const contentY =
//           rowBottom + captionHeight + padding;

//         const contentHeight =
//           rowHeight - captionHeight - padding * 2;

//         drawImageContained(outputPage, labelImage, {
//           x: padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         drawImageContained(outputPage, invoiceImage, {
//           x: columnWidth + padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         const displayOrderNumber = orderStart + slot + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             48,
//           ),
//           {
//             x: padding + 2,
//             y: rowBottom + 7,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         const orderCaption = `Order - ${displayOrderNumber}`;

//         outputPage.drawText(orderCaption, {
//           x: columnWidth - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });

//         outputPage.drawText(orderCaption, {
//           x: A4_WIDTH_PT - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITH invoice, label/mm mode:
//    *
//    * Output sequence:
//    * 1. Cropped label page with SKU + Qty caption
//    * 2. Matching full invoice page
//    */
//   const createAmazonLabelModeWithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = 283.46;
//     const labelHeight = 425.2;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];

//       const labelPageIndex = order.page - 1;
//       const invoicePageIndex = labelPageIndex + 1;

//       if (
//         labelPageIndex < 0 ||
//         invoicePageIndex >= sourceDocument.getPageCount()
//       ) {
//         throw new Error(
//           `Invoice pair is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       /*
//        * Render the cropped shipping label as an image so we can reserve
//        * space at the bottom for SKU and quantity.
//        */
//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         labelPageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const labelOutputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(labelOutputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       labelOutputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       labelOutputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );

//       /*
//        * Add the matching complete invoice immediately after its label.
//        */
//       const [invoicePage] =
//         await outputDocument.copyPages(
//           sourceDocument,
//           [invoicePageIndex],
//         );

//       outputDocument.addPage(invoicePage);
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITHOUT invoice, A4 mode:
//    *
//    * 4 labels per A4 page (2 columns x 2 rows).
//    * Every label gets its SKU and quantity caption.
//    */
//   const createAmazonA4WithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const columns = 2;
//     const rows = 2;
//     const labelsPerPage = columns * rows;

//     const cellWidth = A4_WIDTH_PT / columns;
//     const cellHeight = A4_HEIGHT_PT / rows;

//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += labelsPerPage
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + labelsPerPage,
//       );

//       for (
//         let position = 0;
//         position < batch.length;
//         position += 1
//       ) {
//         const order = batch[position];
//         const labelPageIndex = order.page - 1;

//         if (labelPageIndex < 0) {
//           throw new Error(
//             `Label page is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const labelPng = await renderCroppedPageToPng(
//           sourceBytes,
//           labelPageIndex,
//           crop,
//         );

//         const labelImage =
//           await outputDocument.embedPng(labelPng);

//         const column = position % columns;
//         const row = Math.floor(position / columns);

//         const cellX = column * cellWidth;
//         const cellBottom =
//           A4_HEIGHT_PT - (row + 1) * cellHeight;

//         drawImageContained(outputPage, labelImage, {
//           x: cellX + padding,
//           y: cellBottom + captionHeight + padding,
//           width: cellWidth - padding * 2,
//           height:
//             cellHeight -
//             captionHeight -
//             padding * 2,
//         });

//         const displayOrderNumber =
//           orderStart + position + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             42,
//           ),
//           {
//             x: cellX + padding + 2,
//             y: cellBottom + 8,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         outputPage.drawText(
//           `Order - ${displayOrderNumber}`,
//           {
//             x: cellX + cellWidth - 58,
//             y: cellBottom + 8,
//             size: 7,
//             font: regularFont,
//           },
//         );
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITHOUT invoice, label/mm mode:
//    *
//    * One 100 mm x 150 mm output page per label.
//    * SKU and quantity are printed at the bottom of every page.
//    */
//   const createAmazonLabelModeWithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = 283.46;
//     const labelHeight = 425.2;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const labelPageIndex = order.page - 1;

//       if (labelPageIndex < 0) {
//         throw new Error(
//           `Label page is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         labelPageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const outputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(outputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       outputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       outputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );
//     }

//     return outputDocument.save();
//   };

//   const handleDownload = async () => {
//     if (!pdfBytes || pages.length === 0) return;

//     setProcessing(true);
//     setError(null);

//     try {
//       const sourceDocument = await PDFDocument.load(
//         cloneArrayBuffer(pdfBytes),
//       );

//       let sourcePageIndices = sourceDocument.getPageIndices();

//       if (isAmazon && invoiceMode === "without") {
//         sourcePageIndices = sourcePageIndices.filter(
//           (pageIndex) => pageIndex % 2 === 0,
//         );
//       }

//       if (isAmazon && orders.length === 0) {
//         throw new Error(
//           "Amazon order data was not detected. OCR is not required for this PDF; verify that amazon.ts is replaced with the updated parser.",
//         );
//       }

//       if (orders.length === 0 && filterMode !== "all") {
//         throw new Error(
//           "Could not detect single/multi order details. Use All Orders or verify the parser output.",
//         );
//       }

//       const selectedOrders = filteredAndSortedOrders;

//       if (
//         filterMode !== "all" &&
//         selectedOrders.length === 0
//       ) {
//         throw new Error(
//           `No ${
//             filterMode === "single" ? "single" : "multi"
//           } orders were detected in this PDF.`,
//         );
//       }

//       const sortedLabelPageIndices = selectedOrders.map(
//         (order) => order.page - 1,
//       );

//       const finalIndices =
//         selectedOrders.length > 0
//           ? sortedLabelPageIndices
//           : sourcePageIndices;

//       console.log("Download selection:", {
//         invoiceMode,
//         printMode,
//         filterMode,
//         sortMode,
//         selectedOrders: selectedOrders.map((order) => ({
//           orderId: order.orderId,
//           sku: order.sku,
//           quantity: order.quantity,
//           page: order.page,
//           isMultiOrder: order.isMultiOrder,
//         })),
//         finalIndices,
//       });

//       /*
//        * AMAZON + WITH INVOICE
//        *
//        * This must run before the generic A4 branch. Otherwise the app
//        * creates a 2x2 label-only page, which was the reported issue.
//        */
//       if (isAmazon && invoiceMode === "with") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createAmazonA4WithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               )
//             : await createAmazonLabelModeWithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-invoices-a4"
//               : "amazon-labels-invoices"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * AMAZON + WITHOUT INVOICE
//        *
//        * The generic label-only branch does not know which SKU belongs to
//        * each page, so it cannot print SKU captions. Handle Amazon here
//        * using selectedOrders for All / Single / Multi filters.
//        */
//       if (isAmazon && invoiceMode === "without") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createAmazonA4WithoutInvoices(
//                 pdfBytes,
//                 selectedOrders,
//               )
//             : await createAmazonLabelModeWithoutInvoices(
//                 pdfBytes,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-with-sku-a4"
//               : "amazon-labels-with-sku"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       if (printMode === "a4") {
//         const outputDocument = await PDFDocument.create();

//         const labelsPerA4Page = isMeeshoWithInvoice ? 1 : 4;
//         const columns = isMeeshoWithInvoice ? 1 : 2;

//         const amazonLabelWidth = 283.46;
//         const amazonLabelHeight = 425.2;

//         const labelWidth = isAmazon
//           ? amazonLabelWidth
//           : isMeeshoWithInvoice
//             ? A4_WIDTH_PT
//             : A4_WIDTH_PT / columns;

//         const labelHeight = isAmazon
//           ? amazonLabelHeight
//           : labelWidth / (crop.width / crop.height);

//         const pageHeight = isMeeshoWithInvoice
//           ? labelHeight
//           : labelHeight * 2;

//         const invoiceAspect = invoiceCrop
//           ? invoiceCrop.width / invoiceCrop.height
//           : 0;

//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const invoiceWidth = A4_WIDTH_PT;
//           const invoiceHeight =
//             invoiceWidth / invoiceAspect;

//           const flipkartPageHeight =
//             labelHeight + invoiceHeight;

//           for (const pageIndex of finalIndices) {
//             const [labelPng, invoicePng] =
//               await Promise.all([
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   crop,
//                 ),
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   invoiceCrop,
//                 ),
//               ]);

//             const [embeddedLabel, embeddedInvoice] =
//               await Promise.all([
//                 outputDocument.embedPng(labelPng),
//                 outputDocument.embedPng(invoicePng),
//               ]);

//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               flipkartPageHeight,
//             ]);

//             outputPage.drawImage(embeddedLabel, {
//               x: 0,
//               y: flipkartPageHeight - labelHeight,
//               width: labelWidth,
//               height: labelHeight,
//             });

//             outputPage.drawImage(embeddedInvoice, {
//               x: 0,
//               y: 0,
//               width: invoiceWidth,
//               height: invoiceHeight,
//             });
//           }
//         } else {
//           const labelImages: Array<{
//             image: PDFImage;
//             width: number;
//             height: number;
//           }> = [];

//           for (const pageIndex of finalIndices) {
//             const pngBytes = await renderCroppedPageToPng(
//               pdfBytes,
//               pageIndex,
//               crop,
//             );

//             const embeddedPng =
//               await outputDocument.embedPng(pngBytes);

//             labelImages.push({
//               image: embeddedPng,
//               width: labelWidth,
//               height: labelHeight,
//             });
//           }

//           for (
//             let start = 0;
//             start < labelImages.length;
//             start += labelsPerA4Page
//           ) {
//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               pageHeight,
//             ]);

//             const batch = labelImages.slice(
//               start,
//               start + labelsPerA4Page,
//             );

//             batch.forEach((label, position) => {
//               const column = position % columns;
//               const row = Math.floor(position / columns);

//               const x = column * labelWidth;
//               const y =
//                 pageHeight - (row + 1) * labelHeight;

//               outputPage.drawImage(label.image, {
//                 x,
//                 y,
//                 width: label.width,
//                 height: label.height,
//               });
//             });
//           }
//         }

//         const outputBytes = await outputDocument.save();

//         downloadPdf(
//           outputBytes,
//           `labels-a4-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       const outputDocument = await PDFDocument.create();

//       for (const pageIndex of finalIndices) {
//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const labelBox = getCropBoxFromRegion(
//             crop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [labelPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           labelPage.setMediaBox(
//             labelBox.x,
//             labelBox.y,
//             labelBox.width,
//             labelBox.height,
//           );

//           outputDocument.addPage(labelPage);

//           const invoiceBox = getCropBoxFromRegion(
//             invoiceCrop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [invoicePage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           invoicePage.setMediaBox(
//             invoiceBox.x,
//             invoiceBox.y,
//             invoiceBox.width,
//             invoiceBox.height,
//           );

//           outputDocument.addPage(invoicePage);
//         } else {
//           const [copiedPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           const {
//             width: pageWidth,
//             height: pageHeight,
//           } = copiedPage.getSize();

//           const box = getCropBox(pageWidth, pageHeight);

//           copiedPage.setMediaBox(
//             box.x,
//             box.y,
//             box.width,
//             box.height,
//           );

//           outputDocument.addPage(copiedPage);
//         }
//       }

//       const outputBytes = await outputDocument.save();

//       downloadPdf(
//         outputBytes,
//         `labels-${fileName || "cropped.pdf"}`,
//       );
//     } catch (downloadError) {
//       console.error(downloadError);

//       setError(
//         downloadError instanceof Error
//           ? downloadError.message
//           : "Error cropping PDF. Please try again.",
//       );
//     } finally {
//       setProcessing(false);
//     }
//   };

//   const updateCrop = (
//     key: keyof CropRegion,
//     value: number,
//   ) => {
//     setCrop((previous) => ({
//       ...previous,
//       [key]: value,
//     }));
//   };

//   const resetCrop = () => {
//     setCrop(getEffectiveCrop());
//   };

//   const clearFile = () => {
//     setPdfBytes(null);
//     setPages([]);
//     setFileName(null);
//     setOrders([]);
//     setError(null);
//     onOrdersExtracted([]);
//   };

//   return (
//     <div className="mx-auto max-w-2xl">
//       {!pdfBytes && (
//         <div
//           {...getRootProps()}
//           className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
//             isDragActive
//               ? "border-blue-500 bg-blue-50"
//               : "border-gray-300 hover:border-blue-400"
//           } ${
//             !pdfjs || processing
//               ? "cursor-not-allowed opacity-60"
//               : ""
//           }`}
//         >
//           <input {...getInputProps()} />

//           <svg
//             className="mx-auto h-12 w-12 text-gray-400"
//             stroke="currentColor"
//             fill="none"
//             viewBox="0 0 48 48"
//             aria-hidden="true"
//           >
//             <path
//               d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
//               strokeWidth="2"
//               strokeLinecap="round"
//               strokeLinejoin="round"
//             />
//           </svg>

//           {!pdfjs ? (
//             <p className="mt-2 text-gray-600">
//               Loading PDF engine...
//             </p>
//           ) : isDragActive ? (
//             <p className="mt-2 text-blue-600">
//               Drop the PDF here...
//             </p>
//           ) : (
//             <p className="mt-2 text-gray-600">
//               Drag & drop a PDF here, or{" "}
//               <span className="font-semibold text-blue-600">
//                 browse
//               </span>
//             </p>
//           )}

//           <p className="mt-1 text-sm text-gray-500">
//             PDF files only
//           </p>
//         </div>
//       )}

//       {error && (
//         <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
//           {error}
//         </div>
//       )}

//       {fileName && pages.length > 0 && (
//         <div className="mt-4">
//           <div className="mb-4 flex items-center justify-between">
//             <div className="min-w-0">
//               <p className="text-sm text-gray-500">File</p>
//               <p className="max-w-xs truncate font-medium text-gray-800">
//                 {fileName}
//               </p>
//             </div>

//             <div className="text-right">
//               <p className="text-sm text-gray-500">Pages</p>
//               <p className="text-lg font-bold text-blue-600">
//                 {pages.length}
//               </p>
//             </div>
//           </div>

//           {orders.length > 0 && (
//             <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
//               <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
//                 <p className="text-sm font-semibold text-gray-800">
//                   Detected orders
//                 </p>
//                 <p className="mt-0.5 text-xs text-gray-500">
//                   This confirms the SKU and quantity used for
//                   sorting/filtering.
//                 </p>
//               </div>

//               <div className="max-h-52 overflow-auto">
//                 <table className="w-full text-left text-xs">
//                   <thead className="sticky top-0 bg-white text-gray-500">
//                     <tr>
//                       <th className="px-3 py-2 font-medium">
//                         Order
//                       </th>
//                       <th className="px-3 py-2 font-medium">
//                         SKU
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Qty
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Type
//                       </th>
//                     </tr>
//                   </thead>

//                   <tbody>
//                     {orders.map((order) => (
//                       <tr
//                         key={`${order.page}-${order.orderId}-${order.sku}`}
//                         className="border-t border-gray-100"
//                       >
//                         <td className="whitespace-nowrap px-3 py-2 text-gray-700">
//                           {order.orderId || "-"}
//                         </td>
//                         <td className="px-3 py-2 font-medium text-gray-900">
//                           {order.sku || "Not detected"}
//                         </td>
//                         <td className="px-3 py-2 text-center text-gray-700">
//                           {order.quantity}
//                         </td>
//                         <td className="px-3 py-2 text-center">
//                           <span
//                             className={`rounded-full px-2 py-0.5 font-medium ${
//                               order.isMultiOrder
//                                 ? "bg-amber-100 text-amber-700"
//                                 : "bg-green-100 text-green-700"
//                             }`}
//                           >
//                             {order.isMultiOrder
//                               ? "Multi"
//                               : "Single"}
//                           </span>
//                         </td>
//                       </tr>
//                     ))}
//                   </tbody>
//                 </table>
//               </div>
//             </div>
//           )}

//           <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
//             <div className="mb-3 flex items-center justify-between">
//               <p className="text-sm font-semibold text-gray-700">
//                 Adjust Crop Area
//               </p>

//               <button
//                 type="button"
//                 onClick={resetCrop}
//                 className="cursor-pointer text-xs text-gray-500 underline hover:text-gray-700"
//               >
//                 Reset to default
//               </button>
//             </div>

//             <div className="grid grid-cols-2 gap-x-4 gap-y-3">
//               <Slider
//                 label="Top"
//                 value={crop.top}
//                 onChange={(value) =>
//                   updateCrop("top", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Left"
//                 value={crop.left}
//                 onChange={(value) =>
//                   updateCrop("left", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Width"
//                 value={crop.width}
//                 onChange={(value) =>
//                   updateCrop("width", value)
//                 }
//                 min={10}
//                 max={100}
//               />

//               <Slider
//                 label="Height"
//                 value={crop.height}
//                 onChange={(value) =>
//                   updateCrop("height", value)
//                 }
//                 min={10}
//                 max={100}
//               />
//             </div>

//             <p className="mt-3 text-center text-[11px] text-gray-400">
//               Top {crop.top}% · Left {crop.left}% ·{" "}
//               {crop.width}% × {crop.height}%
//             </p>
//           </div>

//           <div className="max-h-96 space-y-4 overflow-y-auto pr-2">
//             {pages.map((page) => (
//               <div
//                 key={page.index}
//                 className="relative overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
//               >
//                 <div className="absolute left-2 top-2 z-10 rounded bg-blue-600 px-2 py-1 text-xs font-bold text-white">
//                   Page {page.index}
//                 </div>

//                 <div className="relative">
//                   {/* eslint-disable-next-line @next/next/no-img-element */}
//                   <img
//                     src={page.dataUrl}
//                     alt={`Page ${page.index}`}
//                     className="block h-auto w-full"
//                     draggable={false}
//                   />

//                   {!(
//                     isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0
//                   ) && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-green-500"
//                       style={{
//                         top: `${crop.top}%`,
//                         left: `${crop.left}%`,
//                         width: `${crop.width}%`,
//                         height: `${crop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-green-600">
//                         Label
//                       </span>
//                     </div>
//                   )}

//                   {isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0 && (
//                       <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-orange-500">
//                         <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                           Full Invoice
//                         </span>
//                       </div>
//                     )}

//                   {isFlipkartWithInvoice && invoiceCrop && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-orange-500"
//                       style={{
//                         top: `${invoiceCrop.top}%`,
//                         left: `${invoiceCrop.left}%`,
//                         width: `${invoiceCrop.width}%`,
//                         height: `${invoiceCrop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                         Invoice
//                       </span>
//                     </div>
//                   )}
//                 </div>
//               </div>
//             ))}
//           </div>

//           <div className="mt-4 flex gap-3">
//             <button
//               type="button"
//               onClick={() => void handleDownload()}
//               disabled={processing}
//               className="flex-1 cursor-pointer rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               {processing
//                 ? "Processing..."
//                 : "Download Cropped PDF"}
//             </button>

//             <button
//               type="button"
//               onClick={clearFile}
//               disabled={processing}
//               className="cursor-pointer rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               Clear
//             </button>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }

// function Slider({
//   label,
//   value,
//   onChange,
//   min,
//   max,
//   step = 0.1,
// }: {
//   label: string;
//   value: number;
//   onChange: (value: number) => void;
//   min: number;
//   max: number;
//   step?: number;
// }) {
//   return (
//     <div>
//       <div className="mb-1 flex items-center justify-between">
//         <label className="text-xs font-medium text-gray-600">
//           {label}
//         </label>

//         <span className="font-mono text-xs text-gray-500">
//           {value}%
//         </span>
//       </div>

//       <input
//         type="range"
//         min={min}
//         max={max}
//         step={step}
//         value={value}
//         onChange={(event) =>
//           onChange(Number(event.target.value))
//         }
//         className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-indigo-600"
//       />
//     </div>
//   );
// }


// "use client";

// import { useCallback, useEffect, useMemo, useState } from "react";
// import { useDropzone } from "react-dropzone";
// import {
//   PDFDocument,
//   StandardFonts,
//   type PDFImage,
//   type PDFPage,
// } from "pdf-lib";

// import type { CropConfig } from "@/lib/crop-config";
// import type { OrderData } from "@/lib/parsers/types";
// import type { SortMode, FilterMode } from "./FilterOptions";

// import { extractOrders } from "@/lib/parsers";
// import { sortOrders } from "@/lib/parsers/sort";
// import { filterOrders } from "@/lib/parsers/filter";
// import { getPlatformId } from "@/lib/platforms";

// interface PDFCropToolProps {
//   config: CropConfig;
//   printMode: "label" | "a4";
//   platformName: string;
//   invoiceMode: "with" | "without";
//   sortMode: SortMode;
//   filterMode: FilterMode;
//   onOrdersExtracted: (orders: OrderData[]) => void;
// }

// interface PageData {
//   index: number;
//   width: number;
//   height: number;
//   dataUrl: string;
// }

// interface CropRegion {
//   top: number;
//   left: number;
//   width: number;
//   height: number;
// }

// type PdfJsModule = typeof import("pdfjs-dist");

// const A4_WIDTH_PT = 595.28;
// const A4_HEIGHT_PT = 841.89;

// const FULL_PAGE_REGION: CropRegion = {
//   top: 0,
//   left: 0,
//   width: 100,
//   height: 100,
// };

// function cloneArrayBuffer(source: ArrayBuffer): ArrayBuffer {
//   const copy = new ArrayBuffer(source.byteLength);
//   new Uint8Array(copy).set(new Uint8Array(source));
//   return copy;
// }

// function downloadPdf(bytes: Uint8Array, fileName: string): void {
//   const blob = new Blob([bytes], {
//     type: "application/pdf",
//   });

//   const url = URL.createObjectURL(blob);
//   const link = document.createElement("a");

//   link.href = url;
//   link.download = fileName;
//   document.body.appendChild(link);
//   link.click();
//   link.remove();

//   window.setTimeout(() => URL.revokeObjectURL(url), 1000);
// }

// function drawImageContained(
//   page: PDFPage,
//   image: PDFImage,
//   box: {
//     x: number;
//     y: number;
//     width: number;
//     height: number;
//   },
// ): void {
//   const scale = Math.min(
//     box.width / image.width,
//     box.height / image.height,
//   );

//   const width = image.width * scale;
//   const height = image.height * scale;

//   page.drawImage(image, {
//     x: box.x + (box.width - width) / 2,
//     y: box.y + (box.height - height) / 2,
//     width,
//     height,
//   });
// }

// function shortenText(value: string, maximumLength: number): string {
//   if (value.length <= maximumLength) return value;
//   return `${value.slice(0, maximumLength - 3)}...`;
// }

// export default function PDFCropTool({
//   config,
//   printMode,
//   platformName,
//   invoiceMode,
//   sortMode,
//   filterMode,
//   onOrdersExtracted,
// }: PDFCropToolProps) {
//   const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
//   const [pages, setPages] = useState<PageData[]>([]);
//   const [fileName, setFileName] = useState<string | null>(null);
//   const [error, setError] = useState<string | null>(null);
//   const [processing, setProcessing] = useState(false);
//   const [pdfjs, setPdfjs] = useState<PdfJsModule | null>(null);
//   const [orders, setOrders] = useState<OrderData[]>([]);

//   const getEffectiveCrop = useCallback((): CropRegion => {
//     if (platformName === "Meesho" && invoiceMode === "with") {
//       return {
//         top: 1,
//         left: 2,
//         width: 97,
//         height: 78.5,
//       };
//     }

//     return config.region;
//   }, [config.region, invoiceMode, platformName]);

//   const [crop, setCrop] = useState<CropRegion>(() =>
//     getEffectiveCrop(),
//   );

//   useEffect(() => {
//     setCrop(getEffectiveCrop());
//   }, [getEffectiveCrop]);

//   useEffect(() => {
//     let active = true;

//     const loadPdfjs = async () => {
//       try {
//         const pdfJsModule = await import("pdfjs-dist");
//         pdfJsModule.GlobalWorkerOptions.workerSrc =
//           "/pdf.worker.min.mjs";

//         if (active) {
//           setPdfjs(pdfJsModule);
//         }
//       } catch (loadError) {
//         console.error(loadError);

//         if (active) {
//           setError("Could not load the PDF engine.");
//         }
//       }
//     };

//     void loadPdfjs();

//     return () => {
//       active = false;
//     };
//   }, []);

//   const isFlipkartWithInvoice =
//     platformName === "Flipkart" && invoiceMode === "with";

//   const isMeeshoWithInvoice =
//     platformName === "Meesho" && invoiceMode === "with";

//   const isAmazon = platformName === "Amazon";

//   const renderPages = useCallback(
//     async (bytes: ArrayBuffer): Promise<PageData[]> => {
//       if (!pdfjs) return [];

//       const doc = await pdfjs.getDocument({
//         data: cloneArrayBuffer(bytes),
//       }).promise;

//       const newPages: PageData[] = [];

//       for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
//         /*
//          * Amazon original PDF:
//          * odd PDF pages = labels
//          * even PDF pages = invoices
//          *
//          * "Without Invoice" preview should show labels only.
//          */
//         if (
//           platformName === "Amazon" &&
//           invoiceMode === "without" &&
//           pageNumber % 2 === 0
//         ) {
//           continue;
//         }

//         const page = await doc.getPage(pageNumber);
//         const viewport = page.getViewport({ scale: 1.5 });

//         const canvas = document.createElement("canvas");
//         canvas.width = Math.ceil(viewport.width);
//         canvas.height = Math.ceil(viewport.height);

//         const context = canvas.getContext("2d");

//         if (!context) {
//           throw new Error("Canvas is not available.");
//         }

//         context.fillStyle = "#ffffff";
//         context.fillRect(0, 0, canvas.width, canvas.height);

//         await page.render({
//           canvas,
//           canvasContext: context,
//           viewport,
//         }).promise;

//         newPages.push({
//           index: pageNumber,
//           width: viewport.width,
//           height: viewport.height,
//           dataUrl: canvas.toDataURL("image/png"),
//         });
//       }

//       return newPages;
//     },
//     [invoiceMode, pdfjs, platformName],
//   );

//   useEffect(() => {
//     let cancelled = false;

//     const syncPages = async () => {
//       if (!pdfBytes || !pdfjs) return;

//       try {
//         const nextPages = await renderPages(pdfBytes);

//         if (!cancelled) {
//           setPages(nextPages);
//         }
//       } catch (renderError) {
//         console.error(renderError);

//         if (!cancelled) {
//           setError("Could not refresh the PDF preview.");
//         }
//       }
//     };

//     void syncPages();

//     return () => {
//       cancelled = true;
//     };
//   }, [invoiceMode, pdfBytes, pdfjs, renderPages]);

//   const onDrop = useCallback(
//     async (acceptedFiles: File[]) => {
//       setError(null);
//       setPages([]);
//       setFileName(null);
//       setPdfBytes(null);
//       setOrders([]);
//       onOrdersExtracted([]);

//       if (acceptedFiles.length === 0) return;

//       if (!pdfjs) {
//         setError("PDF engine is still loading. Please try again.");
//         return;
//       }

//       const file = acceptedFiles[0];

//       if (
//         file.type !== "application/pdf" &&
//         !file.name.toLowerCase().endsWith(".pdf")
//       ) {
//         setError("Please upload a PDF file.");
//         return;
//       }

//       setFileName(file.name);

//       try {
//         const bytes = await file.arrayBuffer();

//         const [renderedPages, extractedOrders] = await Promise.all([
//           renderPages(bytes),
//           (async () => {
//             const platformId = getPlatformId(platformName);

//             if (!platformId) {
//               throw new Error(
//                 `Could not resolve platform: ${platformName}`,
//               );
//             }

//             return extractOrders(bytes, platformId);
//           })(),
//         ]);

//         console.log(
//           "Extracted orders:",
//           extractedOrders.map((order) => ({
//             page: order.page,
//             orderId: order.orderId,
//             sku: order.sku,
//             quantity: order.quantity,
//             isMultiOrder: order.isMultiOrder,
//           })),
//         );

//         setPdfBytes(bytes);
//         setPages(renderedPages);
//         setOrders(extractedOrders);
//         onOrdersExtracted(extractedOrders);

//         if (
//           platformName === "Amazon" &&
//           extractedOrders.length === 0
//         ) {
//           setError(
//             "No Amazon invoice data was detected. Check the browser console for parser details.",
//           );
//         }
//       } catch (dropError) {
//         console.error(dropError);
//         setError(
//           dropError instanceof Error
//             ? dropError.message
//             : "Error reading PDF. Please try again.",
//         );
//       }
//     },
//     [onOrdersExtracted, pdfjs, platformName, renderPages],
//   );

//   const { getRootProps, getInputProps, isDragActive } =
//     useDropzone({
//       onDrop,
//       accept: {
//         "application/pdf": [".pdf"],
//       },
//       maxFiles: 1,
//       multiple: false,
//       disabled: processing || !pdfjs,
//     });

//   const getCropBox = (
//     pageWidth: number,
//     pageHeight: number,
//   ) => {
//     const widthRatio = crop.width / 100;
//     const heightRatio = crop.height / 100;
//     const topOffset = crop.top / 100;
//     const leftOffset = crop.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const getCropBoxFromRegion = (
//     region: CropRegion,
//     sourceDocument: PDFDocument,
//     pageIndex: number,
//   ) => {
//     const page = sourceDocument.getPage(pageIndex);
//     const { width: pageWidth, height: pageHeight } =
//       page.getSize();

//     const widthRatio = region.width / 100;
//     const heightRatio = region.height / 100;
//     const topOffset = region.top / 100;
//     const leftOffset = region.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const invoiceCrop = config.invoiceRegion;

//   const renderCroppedPageToPng = async (
//     sourceBytes: ArrayBuffer,
//     pageIndex: number,
//     cropRegion: CropRegion = crop,
//   ): Promise<Uint8Array> => {
//     if (!pdfjs) {
//       throw new Error("PDF renderer is not ready.");
//     }

//     const scale = 2;

//     const doc = await pdfjs.getDocument({
//       data: cloneArrayBuffer(sourceBytes),
//     }).promise;

//     if (pageIndex < 0 || pageIndex >= doc.numPages) {
//       throw new Error(
//         `PDF page ${pageIndex + 1} does not exist.`,
//       );
//     }

//     const page = await doc.getPage(pageIndex + 1);
//     const viewport = page.getViewport({ scale });

//     const canvas = document.createElement("canvas");
//     canvas.width = Math.ceil(viewport.width);
//     canvas.height = Math.ceil(viewport.height);

//     const context = canvas.getContext("2d");

//     if (!context) {
//       throw new Error("Canvas is not available.");
//     }

//     context.fillStyle = "#ffffff";
//     context.fillRect(0, 0, canvas.width, canvas.height);

//     await page.render({
//       canvas,
//       canvasContext: context,
//       viewport,
//     }).promise;

//     const cropX = Math.max(
//       0,
//       Math.floor((viewport.width * cropRegion.left) / 100),
//     );

//     const cropY = Math.max(
//       0,
//       Math.floor((viewport.height * cropRegion.top) / 100),
//     );

//     const cropWidth = Math.max(
//       1,
//       Math.min(
//         canvas.width - cropX,
//         Math.floor((viewport.width * cropRegion.width) / 100),
//       ),
//     );

//     const cropHeight = Math.max(
//       1,
//       Math.min(
//         canvas.height - cropY,
//         Math.floor((viewport.height * cropRegion.height) / 100),
//       ),
//     );

//     const croppedCanvas = document.createElement("canvas");
//     croppedCanvas.width = cropWidth;
//     croppedCanvas.height = cropHeight;

//     const croppedContext = croppedCanvas.getContext("2d");

//     if (!croppedContext) {
//       throw new Error("Crop canvas is not available.");
//     }

//     croppedContext.fillStyle = "#ffffff";
//     croppedContext.fillRect(
//       0,
//       0,
//       croppedCanvas.width,
//       croppedCanvas.height,
//     );

//     croppedContext.drawImage(
//       canvas,
//       cropX,
//       cropY,
//       cropWidth,
//       cropHeight,
//       0,
//       0,
//       cropWidth,
//       cropHeight,
//     );

//     const blob = await new Promise<Blob>((resolve, reject) => {
//       croppedCanvas.toBlob((result) => {
//         if (!result) {
//           reject(new Error("Could not create cropped PDF image."));
//           return;
//         }

//         resolve(result);
//       }, "image/png");
//     });

//     return new Uint8Array(await blob.arrayBuffer());
//   };

//   const filteredAndSortedOrders = useMemo(() => {
//     const filtered = filterOrders(orders, filterMode);
//     return sortOrders(filtered, sortMode);
//   }, [filterMode, orders, sortMode]);

//   const createAmazonA4WithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const rowHeight = A4_HEIGHT_PT / 2;
//     const columnWidth = A4_WIDTH_PT / 2;
//     const captionHeight = 20;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += 2
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + 2,
//       );

//       for (let slot = 0; slot < batch.length; slot += 1) {
//         const order = batch[slot];

//         /*
//          * order.page is the one-based shipping-label page.
//          * The matching invoice is the immediately following page.
//          */
//         const labelPageIndex = order.page - 1;
//         const invoicePageIndex = labelPageIndex + 1;

//         if (
//           labelPageIndex < 0 ||
//           invoicePageIndex >= sourceDocument.getPageCount()
//         ) {
//           throw new Error(
//             `Invoice pair is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const [labelPng, invoicePng] = await Promise.all([
//           renderCroppedPageToPng(
//             sourceBytes,
//             labelPageIndex,
//             crop,
//           ),
//           renderCroppedPageToPng(
//             sourceBytes,
//             invoicePageIndex,
//             FULL_PAGE_REGION,
//           ),
//         ]);

//         const [labelImage, invoiceImage] = await Promise.all([
//           outputDocument.embedPng(labelPng),
//           outputDocument.embedPng(invoicePng),
//         ]);

//         const rowBottom =
//           A4_HEIGHT_PT - (slot + 1) * rowHeight;

//         const contentY =
//           rowBottom + captionHeight + padding;

//         const contentHeight =
//           rowHeight - captionHeight - padding * 2;

//         drawImageContained(outputPage, labelImage, {
//           x: padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         drawImageContained(outputPage, invoiceImage, {
//           x: columnWidth + padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         const displayOrderNumber = orderStart + slot + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             48,
//           ),
//           {
//             x: padding + 2,
//             y: rowBottom + 7,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         const orderCaption = `Order - ${displayOrderNumber}`;

//         outputPage.drawText(orderCaption, {
//           x: columnWidth - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });

//         outputPage.drawText(orderCaption, {
//           x: A4_WIDTH_PT - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });
//       }
//     }

//     return outputDocument.save();
//   };

//   const createAmazonLabelModeWithInvoices = async (
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     for (const order of selectedOrders) {
//       const labelPageIndex = order.page - 1;
//       const invoicePageIndex = labelPageIndex + 1;

//       if (
//         labelPageIndex < 0 ||
//         invoicePageIndex >= sourceDocument.getPageCount()
//       ) {
//         throw new Error(
//           `Invoice pair is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       const labelBox = getCropBoxFromRegion(
//         crop,
//         sourceDocument,
//         labelPageIndex,
//       );

//       const [labelPage] = await outputDocument.copyPages(
//         sourceDocument,
//         [labelPageIndex],
//       );

//       labelPage.setMediaBox(
//         labelBox.x,
//         labelBox.y,
//         labelBox.width,
//         labelBox.height,
//       );

//       outputDocument.addPage(labelPage);

//       const [invoicePage] = await outputDocument.copyPages(
//         sourceDocument,
//         [invoicePageIndex],
//       );

//       outputDocument.addPage(invoicePage);
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITHOUT invoice, A4 mode:
//    *
//    * 4 labels per A4 page (2 columns x 2 rows).
//    * Every label gets its SKU and quantity caption.
//    */
//   const createAmazonA4WithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const columns = 2;
//     const rows = 2;
//     const labelsPerPage = columns * rows;

//     const cellWidth = A4_WIDTH_PT / columns;
//     const cellHeight = A4_HEIGHT_PT / rows;

//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += labelsPerPage
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + labelsPerPage,
//       );

//       for (
//         let position = 0;
//         position < batch.length;
//         position += 1
//       ) {
//         const order = batch[position];
//         const labelPageIndex = order.page - 1;

//         if (labelPageIndex < 0) {
//           throw new Error(
//             `Label page is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const labelPng = await renderCroppedPageToPng(
//           sourceBytes,
//           labelPageIndex,
//           crop,
//         );

//         const labelImage =
//           await outputDocument.embedPng(labelPng);

//         const column = position % columns;
//         const row = Math.floor(position / columns);

//         const cellX = column * cellWidth;
//         const cellBottom =
//           A4_HEIGHT_PT - (row + 1) * cellHeight;

//         drawImageContained(outputPage, labelImage, {
//           x: cellX + padding,
//           y: cellBottom + captionHeight + padding,
//           width: cellWidth - padding * 2,
//           height:
//             cellHeight -
//             captionHeight -
//             padding * 2,
//         });

//         const displayOrderNumber =
//           orderStart + position + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             42,
//           ),
//           {
//             x: cellX + padding + 2,
//             y: cellBottom + 8,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         outputPage.drawText(
//           `Order - ${displayOrderNumber}`,
//           {
//             x: cellX + cellWidth - 58,
//             y: cellBottom + 8,
//             size: 7,
//             font: regularFont,
//           },
//         );
//       }
//     }

//     return outputDocument.save();
//   };

//   /**
//    * Amazon WITHOUT invoice, label/mm mode:
//    *
//    * One 100 mm x 150 mm output page per label.
//    * SKU and quantity are printed at the bottom of every page.
//    */
//   const createAmazonLabelModeWithoutInvoices = async (
//     sourceBytes: ArrayBuffer,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const labelWidth = 283.46;
//     const labelHeight = 425.2;
//     const captionHeight = 22;
//     const padding = 6;

//     for (
//       let orderIndex = 0;
//       orderIndex < selectedOrders.length;
//       orderIndex += 1
//     ) {
//       const order = selectedOrders[orderIndex];
//       const labelPageIndex = order.page - 1;

//       if (labelPageIndex < 0) {
//         throw new Error(
//           `Label page is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       const labelPng = await renderCroppedPageToPng(
//         sourceBytes,
//         labelPageIndex,
//         crop,
//       );

//       const labelImage =
//         await outputDocument.embedPng(labelPng);

//       const outputPage = outputDocument.addPage([
//         labelWidth,
//         labelHeight,
//       ]);

//       drawImageContained(outputPage, labelImage, {
//         x: padding,
//         y: captionHeight + padding,
//         width: labelWidth - padding * 2,
//         height:
//           labelHeight -
//           captionHeight -
//           padding * 2,
//       });

//       outputPage.drawText(
//         shortenText(
//           `${order.sku} | Qty - ${order.quantity}`,
//           42,
//         ),
//         {
//           x: padding + 2,
//           y: 8,
//           size: 8,
//           font: boldFont,
//         },
//       );

//       outputPage.drawText(
//         `Order - ${orderIndex + 1}`,
//         {
//           x: labelWidth - 62,
//           y: 8,
//           size: 8,
//           font: regularFont,
//         },
//       );
//     }

//     return outputDocument.save();
//   };

//   const handleDownload = async () => {
//     if (!pdfBytes || pages.length === 0) return;

//     setProcessing(true);
//     setError(null);

//     try {
//       const sourceDocument = await PDFDocument.load(
//         cloneArrayBuffer(pdfBytes),
//       );

//       let sourcePageIndices = sourceDocument.getPageIndices();

//       if (isAmazon && invoiceMode === "without") {
//         sourcePageIndices = sourcePageIndices.filter(
//           (pageIndex) => pageIndex % 2 === 0,
//         );
//       }

//       if (isAmazon && orders.length === 0) {
//         throw new Error(
//           "Amazon order data was not detected. OCR is not required for this PDF; verify that amazon.ts is replaced with the updated parser.",
//         );
//       }

//       if (orders.length === 0 && filterMode !== "all") {
//         throw new Error(
//           "Could not detect single/multi order details. Use All Orders or verify the parser output.",
//         );
//       }

//       const selectedOrders = filteredAndSortedOrders;

//       if (
//         filterMode !== "all" &&
//         selectedOrders.length === 0
//       ) {
//         throw new Error(
//           `No ${
//             filterMode === "single" ? "single" : "multi"
//           } orders were detected in this PDF.`,
//         );
//       }

//       const sortedLabelPageIndices = selectedOrders.map(
//         (order) => order.page - 1,
//       );

//       const finalIndices =
//         selectedOrders.length > 0
//           ? sortedLabelPageIndices
//           : sourcePageIndices;

//       console.log("Download selection:", {
//         invoiceMode,
//         printMode,
//         filterMode,
//         sortMode,
//         selectedOrders: selectedOrders.map((order) => ({
//           orderId: order.orderId,
//           sku: order.sku,
//           quantity: order.quantity,
//           page: order.page,
//           isMultiOrder: order.isMultiOrder,
//         })),
//         finalIndices,
//       });

//       /*
//        * AMAZON + WITH INVOICE
//        *
//        * This must run before the generic A4 branch. Otherwise the app
//        * creates a 2x2 label-only page, which was the reported issue.
//        */
//       if (isAmazon && invoiceMode === "with") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createAmazonA4WithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               )
//             : await createAmazonLabelModeWithInvoices(
//                 sourceDocument,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-invoices-a4"
//               : "amazon-labels-invoices"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       /*
//        * AMAZON + WITHOUT INVOICE
//        *
//        * The generic label-only branch does not know which SKU belongs to
//        * each page, so it cannot print SKU captions. Handle Amazon here
//        * using selectedOrders for All / Single / Multi filters.
//        */
//       if (isAmazon && invoiceMode === "without") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createAmazonA4WithoutInvoices(
//                 pdfBytes,
//                 selectedOrders,
//               )
//             : await createAmazonLabelModeWithoutInvoices(
//                 pdfBytes,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-with-sku-a4"
//               : "amazon-labels-with-sku"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       if (printMode === "a4") {
//         const outputDocument = await PDFDocument.create();

//         const labelsPerA4Page = isMeeshoWithInvoice ? 1 : 4;
//         const columns = isMeeshoWithInvoice ? 1 : 2;

//         const amazonLabelWidth = 283.46;
//         const amazonLabelHeight = 425.2;

//         const labelWidth = isAmazon
//           ? amazonLabelWidth
//           : isMeeshoWithInvoice
//             ? A4_WIDTH_PT
//             : A4_WIDTH_PT / columns;

//         const labelHeight = isAmazon
//           ? amazonLabelHeight
//           : labelWidth / (crop.width / crop.height);

//         const pageHeight = isMeeshoWithInvoice
//           ? labelHeight
//           : labelHeight * 2;

//         const invoiceAspect = invoiceCrop
//           ? invoiceCrop.width / invoiceCrop.height
//           : 0;

//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const invoiceWidth = A4_WIDTH_PT;
//           const invoiceHeight =
//             invoiceWidth / invoiceAspect;

//           const flipkartPageHeight =
//             labelHeight + invoiceHeight;

//           for (const pageIndex of finalIndices) {
//             const [labelPng, invoicePng] =
//               await Promise.all([
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   crop,
//                 ),
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   invoiceCrop,
//                 ),
//               ]);

//             const [embeddedLabel, embeddedInvoice] =
//               await Promise.all([
//                 outputDocument.embedPng(labelPng),
//                 outputDocument.embedPng(invoicePng),
//               ]);

//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               flipkartPageHeight,
//             ]);

//             outputPage.drawImage(embeddedLabel, {
//               x: 0,
//               y: flipkartPageHeight - labelHeight,
//               width: labelWidth,
//               height: labelHeight,
//             });

//             outputPage.drawImage(embeddedInvoice, {
//               x: 0,
//               y: 0,
//               width: invoiceWidth,
//               height: invoiceHeight,
//             });
//           }
//         } else {
//           const labelImages: Array<{
//             image: PDFImage;
//             width: number;
//             height: number;
//           }> = [];

//           for (const pageIndex of finalIndices) {
//             const pngBytes = await renderCroppedPageToPng(
//               pdfBytes,
//               pageIndex,
//               crop,
//             );

//             const embeddedPng =
//               await outputDocument.embedPng(pngBytes);

//             labelImages.push({
//               image: embeddedPng,
//               width: labelWidth,
//               height: labelHeight,
//             });
//           }

//           for (
//             let start = 0;
//             start < labelImages.length;
//             start += labelsPerA4Page
//           ) {
//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               pageHeight,
//             ]);

//             const batch = labelImages.slice(
//               start,
//               start + labelsPerA4Page,
//             );

//             batch.forEach((label, position) => {
//               const column = position % columns;
//               const row = Math.floor(position / columns);

//               const x = column * labelWidth;
//               const y =
//                 pageHeight - (row + 1) * labelHeight;

//               outputPage.drawImage(label.image, {
//                 x,
//                 y,
//                 width: label.width,
//                 height: label.height,
//               });
//             });
//           }
//         }

//         const outputBytes = await outputDocument.save();

//         downloadPdf(
//           outputBytes,
//           `labels-a4-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       const outputDocument = await PDFDocument.create();

//       for (const pageIndex of finalIndices) {
//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const labelBox = getCropBoxFromRegion(
//             crop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [labelPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           labelPage.setMediaBox(
//             labelBox.x,
//             labelBox.y,
//             labelBox.width,
//             labelBox.height,
//           );

//           outputDocument.addPage(labelPage);

//           const invoiceBox = getCropBoxFromRegion(
//             invoiceCrop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [invoicePage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           invoicePage.setMediaBox(
//             invoiceBox.x,
//             invoiceBox.y,
//             invoiceBox.width,
//             invoiceBox.height,
//           );

//           outputDocument.addPage(invoicePage);
//         } else {
//           const [copiedPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           const {
//             width: pageWidth,
//             height: pageHeight,
//           } = copiedPage.getSize();

//           const box = getCropBox(pageWidth, pageHeight);

//           copiedPage.setMediaBox(
//             box.x,
//             box.y,
//             box.width,
//             box.height,
//           );

//           outputDocument.addPage(copiedPage);
//         }
//       }

//       const outputBytes = await outputDocument.save();

//       downloadPdf(
//         outputBytes,
//         `labels-${fileName || "cropped.pdf"}`,
//       );
//     } catch (downloadError) {
//       console.error(downloadError);

//       setError(
//         downloadError instanceof Error
//           ? downloadError.message
//           : "Error cropping PDF. Please try again.",
//       );
//     } finally {
//       setProcessing(false);
//     }
//   };

//   const updateCrop = (
//     key: keyof CropRegion,
//     value: number,
//   ) => {
//     setCrop((previous) => ({
//       ...previous,
//       [key]: value,
//     }));
//   };

//   const resetCrop = () => {
//     setCrop(getEffectiveCrop());
//   };

//   const clearFile = () => {
//     setPdfBytes(null);
//     setPages([]);
//     setFileName(null);
//     setOrders([]);
//     setError(null);
//     onOrdersExtracted([]);
//   };

//   return (
//     <div className="mx-auto max-w-2xl">
//       {!pdfBytes && (
//         <div
//           {...getRootProps()}
//           className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
//             isDragActive
//               ? "border-blue-500 bg-blue-50"
//               : "border-gray-300 hover:border-blue-400"
//           } ${
//             !pdfjs || processing
//               ? "cursor-not-allowed opacity-60"
//               : ""
//           }`}
//         >
//           <input {...getInputProps()} />

//           <svg
//             className="mx-auto h-12 w-12 text-gray-400"
//             stroke="currentColor"
//             fill="none"
//             viewBox="0 0 48 48"
//             aria-hidden="true"
//           >
//             <path
//               d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
//               strokeWidth="2"
//               strokeLinecap="round"
//               strokeLinejoin="round"
//             />
//           </svg>

//           {!pdfjs ? (
//             <p className="mt-2 text-gray-600">
//               Loading PDF engine...
//             </p>
//           ) : isDragActive ? (
//             <p className="mt-2 text-blue-600">
//               Drop the PDF here...
//             </p>
//           ) : (
//             <p className="mt-2 text-gray-600">
//               Drag & drop a PDF here, or{" "}
//               <span className="font-semibold text-blue-600">
//                 browse
//               </span>
//             </p>
//           )}

//           <p className="mt-1 text-sm text-gray-500">
//             PDF files only
//           </p>
//         </div>
//       )}

//       {error && (
//         <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
//           {error}
//         </div>
//       )}

//       {fileName && pages.length > 0 && (
//         <div className="mt-4">
//           <div className="mb-4 flex items-center justify-between">
//             <div className="min-w-0">
//               <p className="text-sm text-gray-500">File</p>
//               <p className="max-w-xs truncate font-medium text-gray-800">
//                 {fileName}
//               </p>
//             </div>

//             <div className="text-right">
//               <p className="text-sm text-gray-500">Pages</p>
//               <p className="text-lg font-bold text-blue-600">
//                 {pages.length}
//               </p>
//             </div>
//           </div>

//           {orders.length > 0 && (
//             <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
//               <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
//                 <p className="text-sm font-semibold text-gray-800">
//                   Detected orders
//                 </p>
//                 <p className="mt-0.5 text-xs text-gray-500">
//                   This confirms the SKU and quantity used for
//                   sorting/filtering.
//                 </p>
//               </div>

//               <div className="max-h-52 overflow-auto">
//                 <table className="w-full text-left text-xs">
//                   <thead className="sticky top-0 bg-white text-gray-500">
//                     <tr>
//                       <th className="px-3 py-2 font-medium">
//                         Order
//                       </th>
//                       <th className="px-3 py-2 font-medium">
//                         SKU
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Qty
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Type
//                       </th>
//                     </tr>
//                   </thead>

//                   <tbody>
//                     {orders.map((order) => (
//                       <tr
//                         key={`${order.page}-${order.orderId}-${order.sku}`}
//                         className="border-t border-gray-100"
//                       >
//                         <td className="whitespace-nowrap px-3 py-2 text-gray-700">
//                           {order.orderId || "-"}
//                         </td>
//                         <td className="px-3 py-2 font-medium text-gray-900">
//                           {order.sku || "Not detected"}
//                         </td>
//                         <td className="px-3 py-2 text-center text-gray-700">
//                           {order.quantity}
//                         </td>
//                         <td className="px-3 py-2 text-center">
//                           <span
//                             className={`rounded-full px-2 py-0.5 font-medium ${
//                               order.isMultiOrder
//                                 ? "bg-amber-100 text-amber-700"
//                                 : "bg-green-100 text-green-700"
//                             }`}
//                           >
//                             {order.isMultiOrder
//                               ? "Multi"
//                               : "Single"}
//                           </span>
//                         </td>
//                       </tr>
//                     ))}
//                   </tbody>
//                 </table>
//               </div>
//             </div>
//           )}

//           <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
//             <div className="mb-3 flex items-center justify-between">
//               <p className="text-sm font-semibold text-gray-700">
//                 Adjust Crop Area
//               </p>

//               <button
//                 type="button"
//                 onClick={resetCrop}
//                 className="cursor-pointer text-xs text-gray-500 underline hover:text-gray-700"
//               >
//                 Reset to default
//               </button>
//             </div>

//             <div className="grid grid-cols-2 gap-x-4 gap-y-3">
//               <Slider
//                 label="Top"
//                 value={crop.top}
//                 onChange={(value) =>
//                   updateCrop("top", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Left"
//                 value={crop.left}
//                 onChange={(value) =>
//                   updateCrop("left", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Width"
//                 value={crop.width}
//                 onChange={(value) =>
//                   updateCrop("width", value)
//                 }
//                 min={10}
//                 max={100}
//               />

//               <Slider
//                 label="Height"
//                 value={crop.height}
//                 onChange={(value) =>
//                   updateCrop("height", value)
//                 }
//                 min={10}
//                 max={100}
//               />
//             </div>

//             <p className="mt-3 text-center text-[11px] text-gray-400">
//               Top {crop.top}% · Left {crop.left}% ·{" "}
//               {crop.width}% × {crop.height}%
//             </p>
//           </div>

//           <div className="max-h-96 space-y-4 overflow-y-auto pr-2">
//             {pages.map((page) => (
//               <div
//                 key={page.index}
//                 className="relative overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
//               >
//                 <div className="absolute left-2 top-2 z-10 rounded bg-blue-600 px-2 py-1 text-xs font-bold text-white">
//                   Page {page.index}
//                 </div>

//                 <div className="relative">
//                   {/* eslint-disable-next-line @next/next/no-img-element */}
//                   <img
//                     src={page.dataUrl}
//                     alt={`Page ${page.index}`}
//                     className="block h-auto w-full"
//                     draggable={false}
//                   />

//                   {!(
//                     isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0
//                   ) && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-green-500"
//                       style={{
//                         top: `${crop.top}%`,
//                         left: `${crop.left}%`,
//                         width: `${crop.width}%`,
//                         height: `${crop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-green-600">
//                         Label
//                       </span>
//                     </div>
//                   )}

//                   {isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0 && (
//                       <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-orange-500">
//                         <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                           Full Invoice
//                         </span>
//                       </div>
//                     )}

//                   {isFlipkartWithInvoice && invoiceCrop && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-orange-500"
//                       style={{
//                         top: `${invoiceCrop.top}%`,
//                         left: `${invoiceCrop.left}%`,
//                         width: `${invoiceCrop.width}%`,
//                         height: `${invoiceCrop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                         Invoice
//                       </span>
//                     </div>
//                   )}
//                 </div>
//               </div>
//             ))}
//           </div>

//           <div className="mt-4 flex gap-3">
//             <button
//               type="button"
//               onClick={() => void handleDownload()}
//               disabled={processing}
//               className="flex-1 cursor-pointer rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               {processing
//                 ? "Processing..."
//                 : "Download Cropped PDF"}
//             </button>

//             <button
//               type="button"
//               onClick={clearFile}
//               disabled={processing}
//               className="cursor-pointer rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               Clear
//             </button>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }

// function Slider({
//   label,
//   value,
//   onChange,
//   min,
//   max,
//   step = 0.1,
// }: {
//   label: string;
//   value: number;
//   onChange: (value: number) => void;
//   min: number;
//   max: number;
//   step?: number;
// }) {
//   return (
//     <div>
//       <div className="mb-1 flex items-center justify-between">
//         <label className="text-xs font-medium text-gray-600">
//           {label}
//         </label>

//         <span className="font-mono text-xs text-gray-500">
//           {value}%
//         </span>
//       </div>

//       <input
//         type="range"
//         min={min}
//         max={max}
//         step={step}
//         value={value}
//         onChange={(event) =>
//           onChange(Number(event.target.value))
//         }
//         className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-indigo-600"
//       />
//     </div>
//   );
// }
// "use client";

// import { useCallback, useEffect, useMemo, useState } from "react";
// import { useDropzone } from "react-dropzone";
// import {
//   PDFDocument,
//   StandardFonts,
//   type PDFImage,
//   type PDFPage,
// } from "pdf-lib";

// import type { CropConfig } from "@/lib/crop-config";
// import type { OrderData } from "@/lib/parsers/types";
// import type { SortMode, FilterMode } from "./FilterOptions";

// import { extractOrders } from "@/lib/parsers";
// import { sortOrders } from "@/lib/parsers/sort";
// import { filterOrders } from "@/lib/parsers/filter";
// import { getPlatformId } from "@/lib/platforms";

// interface PDFCropToolProps {
//   config: CropConfig;
//   printMode: "label" | "a4";
//   platformName: string;
//   invoiceMode: "with" | "without";
//   sortMode: SortMode;
//   filterMode: FilterMode;
//   onOrdersExtracted: (orders: OrderData[]) => void;
// }

// interface PageData {
//   index: number;
//   width: number;
//   height: number;
//   dataUrl: string;
// }

// interface CropRegion {
//   top: number;
//   left: number;
//   width: number;
//   height: number;
// }

// type PdfJsModule = typeof import("pdfjs-dist");

// const A4_WIDTH_PT = 595.28;
// const A4_HEIGHT_PT = 841.89;

// const FULL_PAGE_REGION: CropRegion = {
//   top: 0,
//   left: 0,
//   width: 100,
//   height: 100,
// };

// function cloneArrayBuffer(source: ArrayBuffer): ArrayBuffer {
//   const copy = new ArrayBuffer(source.byteLength);
//   new Uint8Array(copy).set(new Uint8Array(source));
//   return copy;
// }

// function downloadPdf(bytes: Uint8Array, fileName: string): void {
//   const blob = new Blob([bytes], {
//     type: "application/pdf",
//   });

//   const url = URL.createObjectURL(blob);
//   const link = document.createElement("a");

//   link.href = url;
//   link.download = fileName;
//   document.body.appendChild(link);
//   link.click();
//   link.remove();

//   window.setTimeout(() => URL.revokeObjectURL(url), 1000);
// }

// function drawImageContained(
//   page: PDFPage,
//   image: PDFImage,
//   box: {
//     x: number;
//     y: number;
//     width: number;
//     height: number;
//   },
// ): void {
//   const scale = Math.min(
//     box.width / image.width,
//     box.height / image.height,
//   );

//   const width = image.width * scale;
//   const height = image.height * scale;

//   page.drawImage(image, {
//     x: box.x + (box.width - width) / 2,
//     y: box.y + (box.height - height) / 2,
//     width,
//     height,
//   });
// }

// function shortenText(value: string, maximumLength: number): string {
//   if (value.length <= maximumLength) return value;
//   return `${value.slice(0, maximumLength - 3)}...`;
// }

// export default function PDFCropTool({
//   config,
//   printMode,
//   platformName,
//   invoiceMode,
//   sortMode,
//   filterMode,
//   onOrdersExtracted,
// }: PDFCropToolProps) {
//   const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
//   const [pages, setPages] = useState<PageData[]>([]);
//   const [fileName, setFileName] = useState<string | null>(null);
//   const [error, setError] = useState<string | null>(null);
//   const [processing, setProcessing] = useState(false);
//   const [pdfjs, setPdfjs] = useState<PdfJsModule | null>(null);
//   const [orders, setOrders] = useState<OrderData[]>([]);

//   const getEffectiveCrop = useCallback((): CropRegion => {
//     if (platformName === "Meesho" && invoiceMode === "with") {
//       return {
//         top: 1,
//         left: 2,
//         width: 97,
//         height: 78.5,
//       };
//     }

//     return config.region;
//   }, [config.region, invoiceMode, platformName]);

//   const [crop, setCrop] = useState<CropRegion>(() =>
//     getEffectiveCrop(),
//   );

//   useEffect(() => {
//     setCrop(getEffectiveCrop());
//   }, [getEffectiveCrop]);

//   useEffect(() => {
//     let active = true;

//     const loadPdfjs = async () => {
//       try {
//         const pdfJsModule = await import("pdfjs-dist");
//         pdfJsModule.GlobalWorkerOptions.workerSrc =
//           "/pdf.worker.min.mjs";

//         if (active) {
//           setPdfjs(pdfJsModule);
//         }
//       } catch (loadError) {
//         console.error(loadError);

//         if (active) {
//           setError("Could not load the PDF engine.");
//         }
//       }
//     };

//     void loadPdfjs();

//     return () => {
//       active = false;
//     };
//   }, []);

//   const isFlipkartWithInvoice =
//     platformName === "Flipkart" && invoiceMode === "with";

//   const isMeeshoWithInvoice =
//     platformName === "Meesho" && invoiceMode === "with";

//   const isAmazon = platformName === "Amazon";

//   const renderPages = useCallback(
//     async (bytes: ArrayBuffer): Promise<PageData[]> => {
//       if (!pdfjs) return [];

//       const doc = await pdfjs.getDocument({
//         data: cloneArrayBuffer(bytes),
//       }).promise;

//       const newPages: PageData[] = [];

//       for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
//         /*
//          * Amazon original PDF:
//          * odd PDF pages = labels
//          * even PDF pages = invoices
//          *
//          * "Without Invoice" preview should show labels only.
//          */
//         if (
//           platformName === "Amazon" &&
//           invoiceMode === "without" &&
//           pageNumber % 2 === 0
//         ) {
//           continue;
//         }

//         const page = await doc.getPage(pageNumber);
//         const viewport = page.getViewport({ scale: 1.5 });

//         const canvas = document.createElement("canvas");
//         canvas.width = Math.ceil(viewport.width);
//         canvas.height = Math.ceil(viewport.height);

//         const context = canvas.getContext("2d");

//         if (!context) {
//           throw new Error("Canvas is not available.");
//         }

//         context.fillStyle = "#ffffff";
//         context.fillRect(0, 0, canvas.width, canvas.height);

//         await page.render({
//           canvas,
//           canvasContext: context,
//           viewport,
//         }).promise;

//         newPages.push({
//           index: pageNumber,
//           width: viewport.width,
//           height: viewport.height,
//           dataUrl: canvas.toDataURL("image/png"),
//         });
//       }

//       return newPages;
//     },
//     [invoiceMode, pdfjs, platformName],
//   );

//   useEffect(() => {
//     let cancelled = false;

//     const syncPages = async () => {
//       if (!pdfBytes || !pdfjs) return;

//       try {
//         const nextPages = await renderPages(pdfBytes);

//         if (!cancelled) {
//           setPages(nextPages);
//         }
//       } catch (renderError) {
//         console.error(renderError);

//         if (!cancelled) {
//           setError("Could not refresh the PDF preview.");
//         }
//       }
//     };

//     void syncPages();

//     return () => {
//       cancelled = true;
//     };
//   }, [invoiceMode, pdfBytes, pdfjs, renderPages]);

//   const onDrop = useCallback(
//     async (acceptedFiles: File[]) => {
//       setError(null);
//       setPages([]);
//       setFileName(null);
//       setPdfBytes(null);
//       setOrders([]);
//       onOrdersExtracted([]);

//       if (acceptedFiles.length === 0) return;

//       if (!pdfjs) {
//         setError("PDF engine is still loading. Please try again.");
//         return;
//       }

//       const file = acceptedFiles[0];

//       if (
//         file.type !== "application/pdf" &&
//         !file.name.toLowerCase().endsWith(".pdf")
//       ) {
//         setError("Please upload a PDF file.");
//         return;
//       }

//       setFileName(file.name);

//       try {
//         const bytes = await file.arrayBuffer();

//         const [renderedPages, extractedOrders] = await Promise.all([
//           renderPages(bytes),
//           (async () => {
//             const platformId = getPlatformId(platformName);

//             if (!platformId) {
//               throw new Error(
//                 `Could not resolve platform: ${platformName}`,
//               );
//             }

//             return extractOrders(bytes, platformId);
//           })(),
//         ]);

//         console.log(
//           "Extracted orders:",
//           extractedOrders.map((order) => ({
//             page: order.page,
//             orderId: order.orderId,
//             sku: order.sku,
//             quantity: order.quantity,
//             isMultiOrder: order.isMultiOrder,
//           })),
//         );

//         setPdfBytes(bytes);
//         setPages(renderedPages);
//         setOrders(extractedOrders);
//         onOrdersExtracted(extractedOrders);

//         if (
//           platformName === "Amazon" &&
//           extractedOrders.length === 0
//         ) {
//           setError(
//             "No Amazon invoice data was detected. Check the browser console for parser details.",
//           );
//         }
//       } catch (dropError) {
//         console.error(dropError);
//         setError(
//           dropError instanceof Error
//             ? dropError.message
//             : "Error reading PDF. Please try again.",
//         );
//       }
//     },
//     [onOrdersExtracted, pdfjs, platformName, renderPages],
//   );

//   const { getRootProps, getInputProps, isDragActive } =
//     useDropzone({
//       onDrop,
//       accept: {
//         "application/pdf": [".pdf"],
//       },
//       maxFiles: 1,
//       multiple: false,
//       disabled: processing || !pdfjs,
//     });

//   const getCropBox = (
//     pageWidth: number,
//     pageHeight: number,
//   ) => {
//     const widthRatio = crop.width / 100;
//     const heightRatio = crop.height / 100;
//     const topOffset = crop.top / 100;
//     const leftOffset = crop.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const getCropBoxFromRegion = (
//     region: CropRegion,
//     sourceDocument: PDFDocument,
//     pageIndex: number,
//   ) => {
//     const page = sourceDocument.getPage(pageIndex);
//     const { width: pageWidth, height: pageHeight } =
//       page.getSize();

//     const widthRatio = region.width / 100;
//     const heightRatio = region.height / 100;
//     const topOffset = region.top / 100;
//     const leftOffset = region.left / 100;

//     return {
//       x: pageWidth * leftOffset,
//       y: pageHeight * (1 - topOffset - heightRatio),
//       width: pageWidth * widthRatio,
//       height: pageHeight * heightRatio,
//     };
//   };

//   const invoiceCrop = config.invoiceRegion;

//   const renderCroppedPageToPng = async (
//     sourceBytes: ArrayBuffer,
//     pageIndex: number,
//     cropRegion: CropRegion = crop,
//   ): Promise<Uint8Array> => {
//     if (!pdfjs) {
//       throw new Error("PDF renderer is not ready.");
//     }

//     const scale = 2;

//     const doc = await pdfjs.getDocument({
//       data: cloneArrayBuffer(sourceBytes),
//     }).promise;

//     if (pageIndex < 0 || pageIndex >= doc.numPages) {
//       throw new Error(
//         `PDF page ${pageIndex + 1} does not exist.`,
//       );
//     }

//     const page = await doc.getPage(pageIndex + 1);
//     const viewport = page.getViewport({ scale });

//     const canvas = document.createElement("canvas");
//     canvas.width = Math.ceil(viewport.width);
//     canvas.height = Math.ceil(viewport.height);

//     const context = canvas.getContext("2d");

//     if (!context) {
//       throw new Error("Canvas is not available.");
//     }

//     context.fillStyle = "#ffffff";
//     context.fillRect(0, 0, canvas.width, canvas.height);

//     await page.render({
//       canvas,
//       canvasContext: context,
//       viewport,
//     }).promise;

//     const cropX = Math.max(
//       0,
//       Math.floor((viewport.width * cropRegion.left) / 100),
//     );

//     const cropY = Math.max(
//       0,
//       Math.floor((viewport.height * cropRegion.top) / 100),
//     );

//     const cropWidth = Math.max(
//       1,
//       Math.min(
//         canvas.width - cropX,
//         Math.floor((viewport.width * cropRegion.width) / 100),
//       ),
//     );

//     const cropHeight = Math.max(
//       1,
//       Math.min(
//         canvas.height - cropY,
//         Math.floor((viewport.height * cropRegion.height) / 100),
//       ),
//     );

//     const croppedCanvas = document.createElement("canvas");
//     croppedCanvas.width = cropWidth;
//     croppedCanvas.height = cropHeight;

//     const croppedContext = croppedCanvas.getContext("2d");

//     if (!croppedContext) {
//       throw new Error("Crop canvas is not available.");
//     }

//     croppedContext.fillStyle = "#ffffff";
//     croppedContext.fillRect(
//       0,
//       0,
//       croppedCanvas.width,
//       croppedCanvas.height,
//     );

//     croppedContext.drawImage(
//       canvas,
//       cropX,
//       cropY,
//       cropWidth,
//       cropHeight,
//       0,
//       0,
//       cropWidth,
//       cropHeight,
//     );

//     const blob = await new Promise<Blob>((resolve, reject) => {
//       croppedCanvas.toBlob((result) => {
//         if (!result) {
//           reject(new Error("Could not create cropped PDF image."));
//           return;
//         }

//         resolve(result);
//       }, "image/png");
//     });

//     return new Uint8Array(await blob.arrayBuffer());
//   };

//   const filteredAndSortedOrders = useMemo(() => {
//     const filtered = filterOrders(orders, filterMode);
//     return sortOrders(filtered, sortMode);
//   }, [filterMode, orders, sortMode]);

//   const createAmazonA4WithInvoices = async (
//     sourceBytes: ArrayBuffer,
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     const regularFont = await outputDocument.embedFont(
//       StandardFonts.Helvetica,
//     );

//     const boldFont = await outputDocument.embedFont(
//       StandardFonts.HelveticaBold,
//     );

//     const rowHeight = A4_HEIGHT_PT / 2;
//     const columnWidth = A4_WIDTH_PT / 2;
//     const captionHeight = 20;
//     const padding = 6;

//     for (
//       let orderStart = 0;
//       orderStart < selectedOrders.length;
//       orderStart += 2
//     ) {
//       const outputPage = outputDocument.addPage([
//         A4_WIDTH_PT,
//         A4_HEIGHT_PT,
//       ]);

//       const batch = selectedOrders.slice(
//         orderStart,
//         orderStart + 2,
//       );

//       for (let slot = 0; slot < batch.length; slot += 1) {
//         const order = batch[slot];

//         /*
//          * order.page is the one-based shipping-label page.
//          * The matching invoice is the immediately following page.
//          */
//         const labelPageIndex = order.page - 1;
//         const invoicePageIndex = labelPageIndex + 1;

//         if (
//           labelPageIndex < 0 ||
//           invoicePageIndex >= sourceDocument.getPageCount()
//         ) {
//           throw new Error(
//             `Invoice pair is missing for Amazon order ${order.orderId}.`,
//           );
//         }

//         const [labelPng, invoicePng] = await Promise.all([
//           renderCroppedPageToPng(
//             sourceBytes,
//             labelPageIndex,
//             crop,
//           ),
//           renderCroppedPageToPng(
//             sourceBytes,
//             invoicePageIndex,
//             FULL_PAGE_REGION,
//           ),
//         ]);

//         const [labelImage, invoiceImage] = await Promise.all([
//           outputDocument.embedPng(labelPng),
//           outputDocument.embedPng(invoicePng),
//         ]);

//         const rowBottom =
//           A4_HEIGHT_PT - (slot + 1) * rowHeight;

//         const contentY =
//           rowBottom + captionHeight + padding;

//         const contentHeight =
//           rowHeight - captionHeight - padding * 2;

//         drawImageContained(outputPage, labelImage, {
//           x: padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         drawImageContained(outputPage, invoiceImage, {
//           x: columnWidth + padding,
//           y: contentY,
//           width: columnWidth - padding * 2,
//           height: contentHeight,
//         });

//         const displayOrderNumber = orderStart + slot + 1;

//         outputPage.drawText(
//           shortenText(
//             `${order.sku} | Qty - ${order.quantity}`,
//             48,
//           ),
//           {
//             x: padding + 2,
//             y: rowBottom + 7,
//             size: 7,
//             font: boldFont,
//           },
//         );

//         const orderCaption = `Order - ${displayOrderNumber}`;

//         outputPage.drawText(orderCaption, {
//           x: columnWidth - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });

//         outputPage.drawText(orderCaption, {
//           x: A4_WIDTH_PT - 58,
//           y: rowBottom + 7,
//           size: 7,
//           font: regularFont,
//         });
//       }
//     }

//     return outputDocument.save();
//   };

//   const createAmazonLabelModeWithInvoices = async (
//     sourceDocument: PDFDocument,
//     selectedOrders: OrderData[],
//   ): Promise<Uint8Array> => {
//     const outputDocument = await PDFDocument.create();

//     for (const order of selectedOrders) {
//       const labelPageIndex = order.page - 1;
//       const invoicePageIndex = labelPageIndex + 1;

//       if (
//         labelPageIndex < 0 ||
//         invoicePageIndex >= sourceDocument.getPageCount()
//       ) {
//         throw new Error(
//           `Invoice pair is missing for Amazon order ${order.orderId}.`,
//         );
//       }

//       const labelBox = getCropBoxFromRegion(
//         crop,
//         sourceDocument,
//         labelPageIndex,
//       );

//       const [labelPage] = await outputDocument.copyPages(
//         sourceDocument,
//         [labelPageIndex],
//       );

//       labelPage.setMediaBox(
//         labelBox.x,
//         labelBox.y,
//         labelBox.width,
//         labelBox.height,
//       );

//       outputDocument.addPage(labelPage);

//       const [invoicePage] = await outputDocument.copyPages(
//         sourceDocument,
//         [invoicePageIndex],
//       );

//       outputDocument.addPage(invoicePage);
//     }

//     return outputDocument.save();
//   };

//   const handleDownload = async () => {
//     if (!pdfBytes || pages.length === 0) return;

//     setProcessing(true);
//     setError(null);

//     try {
//       const sourceDocument = await PDFDocument.load(
//         cloneArrayBuffer(pdfBytes),
//       );

//       let sourcePageIndices = sourceDocument.getPageIndices();

//       if (isAmazon && invoiceMode === "without") {
//         sourcePageIndices = sourcePageIndices.filter(
//           (pageIndex) => pageIndex % 2 === 0,
//         );
//       }

//       if (isAmazon && orders.length === 0) {
//         throw new Error(
//           "Amazon order data was not detected. OCR is not required for this PDF; verify that amazon.ts is replaced with the updated parser.",
//         );
//       }

//       if (orders.length === 0 && filterMode !== "all") {
//         throw new Error(
//           "Could not detect single/multi order details. Use All Orders or verify the parser output.",
//         );
//       }

//       const selectedOrders = filteredAndSortedOrders;

//       if (
//         filterMode !== "all" &&
//         selectedOrders.length === 0
//       ) {
//         throw new Error(
//           `No ${
//             filterMode === "single" ? "single" : "multi"
//           } orders were detected in this PDF.`,
//         );
//       }

//       const sortedLabelPageIndices = selectedOrders.map(
//         (order) => order.page - 1,
//       );

//       const finalIndices =
//         selectedOrders.length > 0
//           ? sortedLabelPageIndices
//           : sourcePageIndices;

//       console.log("Download selection:", {
//         invoiceMode,
//         printMode,
//         filterMode,
//         sortMode,
//         selectedOrders: selectedOrders.map((order) => ({
//           orderId: order.orderId,
//           sku: order.sku,
//           quantity: order.quantity,
//           page: order.page,
//           isMultiOrder: order.isMultiOrder,
//         })),
//         finalIndices,
//       });

//       /*
//        * AMAZON + WITH INVOICE
//        *
//        * This must run before the generic A4 branch. Otherwise the app
//        * creates a 2x2 label-only page, which was the reported issue.
//        */
//       if (isAmazon && invoiceMode === "with") {
//         const outputBytes =
//           printMode === "a4"
//             ? await createAmazonA4WithInvoices(
//                 pdfBytes,
//                 sourceDocument,
//                 selectedOrders,
//               )
//             : await createAmazonLabelModeWithInvoices(
//                 sourceDocument,
//                 selectedOrders,
//               );

//         downloadPdf(
//           outputBytes,
//           `${
//             printMode === "a4"
//               ? "amazon-labels-invoices-a4"
//               : "amazon-labels-invoices"
//           }-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       if (printMode === "a4") {
//         const outputDocument = await PDFDocument.create();

//         const labelsPerA4Page = isMeeshoWithInvoice ? 1 : 4;
//         const columns = isMeeshoWithInvoice ? 1 : 2;

//         const amazonLabelWidth = 283.46;
//         const amazonLabelHeight = 425.2;

//         const labelWidth = isAmazon
//           ? amazonLabelWidth
//           : isMeeshoWithInvoice
//             ? A4_WIDTH_PT
//             : A4_WIDTH_PT / columns;

//         const labelHeight = isAmazon
//           ? amazonLabelHeight
//           : labelWidth / (crop.width / crop.height);

//         const pageHeight = isMeeshoWithInvoice
//           ? labelHeight
//           : labelHeight * 2;

//         const invoiceAspect = invoiceCrop
//           ? invoiceCrop.width / invoiceCrop.height
//           : 0;

//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const invoiceWidth = A4_WIDTH_PT;
//           const invoiceHeight =
//             invoiceWidth / invoiceAspect;

//           const flipkartPageHeight =
//             labelHeight + invoiceHeight;

//           for (const pageIndex of finalIndices) {
//             const [labelPng, invoicePng] =
//               await Promise.all([
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   crop,
//                 ),
//                 renderCroppedPageToPng(
//                   pdfBytes,
//                   pageIndex,
//                   invoiceCrop,
//                 ),
//               ]);

//             const [embeddedLabel, embeddedInvoice] =
//               await Promise.all([
//                 outputDocument.embedPng(labelPng),
//                 outputDocument.embedPng(invoicePng),
//               ]);

//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               flipkartPageHeight,
//             ]);

//             outputPage.drawImage(embeddedLabel, {
//               x: 0,
//               y: flipkartPageHeight - labelHeight,
//               width: labelWidth,
//               height: labelHeight,
//             });

//             outputPage.drawImage(embeddedInvoice, {
//               x: 0,
//               y: 0,
//               width: invoiceWidth,
//               height: invoiceHeight,
//             });
//           }
//         } else {
//           const labelImages: Array<{
//             image: PDFImage;
//             width: number;
//             height: number;
//           }> = [];

//           for (const pageIndex of finalIndices) {
//             const pngBytes = await renderCroppedPageToPng(
//               pdfBytes,
//               pageIndex,
//               crop,
//             );

//             const embeddedPng =
//               await outputDocument.embedPng(pngBytes);

//             labelImages.push({
//               image: embeddedPng,
//               width: labelWidth,
//               height: labelHeight,
//             });
//           }

//           for (
//             let start = 0;
//             start < labelImages.length;
//             start += labelsPerA4Page
//           ) {
//             const outputPage = outputDocument.addPage([
//               A4_WIDTH_PT,
//               pageHeight,
//             ]);

//             const batch = labelImages.slice(
//               start,
//               start + labelsPerA4Page,
//             );

//             batch.forEach((label, position) => {
//               const column = position % columns;
//               const row = Math.floor(position / columns);

//               const x = column * labelWidth;
//               const y =
//                 pageHeight - (row + 1) * labelHeight;

//               outputPage.drawImage(label.image, {
//                 x,
//                 y,
//                 width: label.width,
//                 height: label.height,
//               });
//             });
//           }
//         }

//         const outputBytes = await outputDocument.save();

//         downloadPdf(
//           outputBytes,
//           `labels-a4-${fileName || "cropped.pdf"}`,
//         );

//         return;
//       }

//       const outputDocument = await PDFDocument.create();

//       for (const pageIndex of finalIndices) {
//         if (isFlipkartWithInvoice && invoiceCrop) {
//           const labelBox = getCropBoxFromRegion(
//             crop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [labelPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           labelPage.setMediaBox(
//             labelBox.x,
//             labelBox.y,
//             labelBox.width,
//             labelBox.height,
//           );

//           outputDocument.addPage(labelPage);

//           const invoiceBox = getCropBoxFromRegion(
//             invoiceCrop,
//             sourceDocument,
//             pageIndex,
//           );

//           const [invoicePage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           invoicePage.setMediaBox(
//             invoiceBox.x,
//             invoiceBox.y,
//             invoiceBox.width,
//             invoiceBox.height,
//           );

//           outputDocument.addPage(invoicePage);
//         } else {
//           const [copiedPage] = await outputDocument.copyPages(
//             sourceDocument,
//             [pageIndex],
//           );

//           const {
//             width: pageWidth,
//             height: pageHeight,
//           } = copiedPage.getSize();

//           const box = getCropBox(pageWidth, pageHeight);

//           copiedPage.setMediaBox(
//             box.x,
//             box.y,
//             box.width,
//             box.height,
//           );

//           outputDocument.addPage(copiedPage);
//         }
//       }

//       const outputBytes = await outputDocument.save();

//       downloadPdf(
//         outputBytes,
//         `labels-${fileName || "cropped.pdf"}`,
//       );
//     } catch (downloadError) {
//       console.error(downloadError);

//       setError(
//         downloadError instanceof Error
//           ? downloadError.message
//           : "Error cropping PDF. Please try again.",
//       );
//     } finally {
//       setProcessing(false);
//     }
//   };

//   const updateCrop = (
//     key: keyof CropRegion,
//     value: number,
//   ) => {
//     setCrop((previous) => ({
//       ...previous,
//       [key]: value,
//     }));
//   };

//   const resetCrop = () => {
//     setCrop(getEffectiveCrop());
//   };

//   const clearFile = () => {
//     setPdfBytes(null);
//     setPages([]);
//     setFileName(null);
//     setOrders([]);
//     setError(null);
//     onOrdersExtracted([]);
//   };

//   return (
//     <div className="mx-auto max-w-2xl">
//       {!pdfBytes && (
//         <div
//           {...getRootProps()}
//           className={`cursor-pointer rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
//             isDragActive
//               ? "border-blue-500 bg-blue-50"
//               : "border-gray-300 hover:border-blue-400"
//           } ${
//             !pdfjs || processing
//               ? "cursor-not-allowed opacity-60"
//               : ""
//           }`}
//         >
//           <input {...getInputProps()} />

//           <svg
//             className="mx-auto h-12 w-12 text-gray-400"
//             stroke="currentColor"
//             fill="none"
//             viewBox="0 0 48 48"
//             aria-hidden="true"
//           >
//             <path
//               d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
//               strokeWidth="2"
//               strokeLinecap="round"
//               strokeLinejoin="round"
//             />
//           </svg>

//           {!pdfjs ? (
//             <p className="mt-2 text-gray-600">
//               Loading PDF engine...
//             </p>
//           ) : isDragActive ? (
//             <p className="mt-2 text-blue-600">
//               Drop the PDF here...
//             </p>
//           ) : (
//             <p className="mt-2 text-gray-600">
//               Drag & drop a PDF here, or{" "}
//               <span className="font-semibold text-blue-600">
//                 browse
//               </span>
//             </p>
//           )}

//           <p className="mt-1 text-sm text-gray-500">
//             PDF files only
//           </p>
//         </div>
//       )}

//       {error && (
//         <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
//           {error}
//         </div>
//       )}

//       {fileName && pages.length > 0 && (
//         <div className="mt-4">
//           <div className="mb-4 flex items-center justify-between">
//             <div className="min-w-0">
//               <p className="text-sm text-gray-500">File</p>
//               <p className="max-w-xs truncate font-medium text-gray-800">
//                 {fileName}
//               </p>
//             </div>

//             <div className="text-right">
//               <p className="text-sm text-gray-500">Pages</p>
//               <p className="text-lg font-bold text-blue-600">
//                 {pages.length}
//               </p>
//             </div>
//           </div>

//           {orders.length > 0 && (
//             <div className="mb-4 overflow-hidden rounded-lg border border-gray-200 bg-white">
//               <div className="border-b border-gray-200 bg-gray-50 px-4 py-3">
//                 <p className="text-sm font-semibold text-gray-800">
//                   Detected orders
//                 </p>
//                 <p className="mt-0.5 text-xs text-gray-500">
//                   This confirms the SKU and quantity used for
//                   sorting/filtering.
//                 </p>
//               </div>

//               <div className="max-h-52 overflow-auto">
//                 <table className="w-full text-left text-xs">
//                   <thead className="sticky top-0 bg-white text-gray-500">
//                     <tr>
//                       <th className="px-3 py-2 font-medium">
//                         Order
//                       </th>
//                       <th className="px-3 py-2 font-medium">
//                         SKU
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Qty
//                       </th>
//                       <th className="px-3 py-2 text-center font-medium">
//                         Type
//                       </th>
//                     </tr>
//                   </thead>

//                   <tbody>
//                     {orders.map((order) => (
//                       <tr
//                         key={`${order.page}-${order.orderId}-${order.sku}`}
//                         className="border-t border-gray-100"
//                       >
//                         <td className="whitespace-nowrap px-3 py-2 text-gray-700">
//                           {order.orderId || "-"}
//                         </td>
//                         <td className="px-3 py-2 font-medium text-gray-900">
//                           {order.sku || "Not detected"}
//                         </td>
//                         <td className="px-3 py-2 text-center text-gray-700">
//                           {order.quantity}
//                         </td>
//                         <td className="px-3 py-2 text-center">
//                           <span
//                             className={`rounded-full px-2 py-0.5 font-medium ${
//                               order.isMultiOrder
//                                 ? "bg-amber-100 text-amber-700"
//                                 : "bg-green-100 text-green-700"
//                             }`}
//                           >
//                             {order.isMultiOrder
//                               ? "Multi"
//                               : "Single"}
//                           </span>
//                         </td>
//                       </tr>
//                     ))}
//                   </tbody>
//                 </table>
//               </div>
//             </div>
//           )}

//           <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
//             <div className="mb-3 flex items-center justify-between">
//               <p className="text-sm font-semibold text-gray-700">
//                 Adjust Crop Area
//               </p>

//               <button
//                 type="button"
//                 onClick={resetCrop}
//                 className="cursor-pointer text-xs text-gray-500 underline hover:text-gray-700"
//               >
//                 Reset to default
//               </button>
//             </div>

//             <div className="grid grid-cols-2 gap-x-4 gap-y-3">
//               <Slider
//                 label="Top"
//                 value={crop.top}
//                 onChange={(value) =>
//                   updateCrop("top", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Left"
//                 value={crop.left}
//                 onChange={(value) =>
//                   updateCrop("left", value)
//                 }
//                 min={0}
//                 max={100}
//               />

//               <Slider
//                 label="Width"
//                 value={crop.width}
//                 onChange={(value) =>
//                   updateCrop("width", value)
//                 }
//                 min={10}
//                 max={100}
//               />

//               <Slider
//                 label="Height"
//                 value={crop.height}
//                 onChange={(value) =>
//                   updateCrop("height", value)
//                 }
//                 min={10}
//                 max={100}
//               />
//             </div>

//             <p className="mt-3 text-center text-[11px] text-gray-400">
//               Top {crop.top}% · Left {crop.left}% ·{" "}
//               {crop.width}% × {crop.height}%
//             </p>
//           </div>

//           <div className="max-h-96 space-y-4 overflow-y-auto pr-2">
//             {pages.map((page) => (
//               <div
//                 key={page.index}
//                 className="relative overflow-hidden rounded-lg border border-gray-200 bg-gray-100"
//               >
//                 <div className="absolute left-2 top-2 z-10 rounded bg-blue-600 px-2 py-1 text-xs font-bold text-white">
//                   Page {page.index}
//                 </div>

//                 <div className="relative">
//                   {/* eslint-disable-next-line @next/next/no-img-element */}
//                   <img
//                     src={page.dataUrl}
//                     alt={`Page ${page.index}`}
//                     className="block h-auto w-full"
//                     draggable={false}
//                   />

//                   {!(
//                     isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0
//                   ) && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-green-500"
//                       style={{
//                         top: `${crop.top}%`,
//                         left: `${crop.left}%`,
//                         width: `${crop.width}%`,
//                         height: `${crop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-green-600">
//                         Label
//                       </span>
//                     </div>
//                   )}

//                   {isAmazon &&
//                     invoiceMode === "with" &&
//                     page.index % 2 === 0 && (
//                       <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-orange-500">
//                         <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                           Full Invoice
//                         </span>
//                       </div>
//                     )}

//                   {isFlipkartWithInvoice && invoiceCrop && (
//                     <div
//                       className="pointer-events-none absolute border-2 border-dashed border-orange-500"
//                       style={{
//                         top: `${invoiceCrop.top}%`,
//                         left: `${invoiceCrop.left}%`,
//                         width: `${invoiceCrop.width}%`,
//                         height: `${invoiceCrop.height}%`,
//                       }}
//                     >
//                       <span className="absolute bottom-1 right-2 rounded bg-white/80 px-1 text-[10px] font-bold text-orange-600">
//                         Invoice
//                       </span>
//                     </div>
//                   )}
//                 </div>
//               </div>
//             ))}
//           </div>

//           <div className="mt-4 flex gap-3">
//             <button
//               type="button"
//               onClick={() => void handleDownload()}
//               disabled={processing}
//               className="flex-1 cursor-pointer rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               {processing
//                 ? "Processing..."
//                 : "Download Cropped PDF"}
//             </button>

//             <button
//               type="button"
//               onClick={clearFile}
//               disabled={processing}
//               className="cursor-pointer rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
//             >
//               Clear
//             </button>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }

// function Slider({
//   label,
//   value,
//   onChange,
//   min,
//   max,
//   step = 0.1,
// }: {
//   label: string;
//   value: number;
//   onChange: (value: number) => void;
//   min: number;
//   max: number;
//   step?: number;
// }) {
//   return (
//     <div>
//       <div className="mb-1 flex items-center justify-between">
//         <label className="text-xs font-medium text-gray-600">
//           {label}
//         </label>

//         <span className="font-mono text-xs text-gray-500">
//           {value}%
//         </span>
//       </div>

//       <input
//         type="range"
//         min={min}
//         max={max}
//         step={step}
//         value={value}
//         onChange={(event) =>
//           onChange(Number(event.target.value))
//         }
//         className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-indigo-600"
//       />
//     </div>
//   );
// }
