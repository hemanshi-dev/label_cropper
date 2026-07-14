"use client";

import { useState } from "react";

import PlatformSelector from "@/components/PlatformSelector";
import FilterOptions, {
  type SortMode,
  type InvoiceMode,
  type PrintMode,
  type FilterMode,
} from "@/components/FilterOptions";
import PDFCropTool from "@/components/PDFCropTool";

import {
  getPlatform,
  type PlatformID,
} from "@/lib/platforms";

import { getCropConfig } from "@/lib/crop-config";
import type { OrderData } from "@/lib/parsers/types";

export default function HomePage() {
  const [selectedPlatform, setSelectedPlatform] =
    useState<PlatformID | null>(null);

  const [sortMode, setSortMode] =
    useState<SortMode>("sku");

  const [filterMode, setFilterMode] =
    useState<FilterMode>("all");

  const [invoiceMode, setInvoiceMode] =
    useState<InvoiceMode>("with");

  const [printMode, setPrintMode] =
    useState<PrintMode>("label");

  const [orders, setOrders] = useState<OrderData[]>([]);

  const template = selectedPlatform
    ? getPlatform(selectedPlatform)
    : null;

  const cropConfig = selectedPlatform
    ? getCropConfig(selectedPlatform)
    : null;

  /*
   * For every platform:
   * With Invoice    => A4 visible but disabled
   * Without Invoice => A4 enabled
   */
  const disableA4Mode = invoiceMode === "with";

  const handlePlatformSelect = (
    platformId: PlatformID,
  ) => {
    setSelectedPlatform(platformId);
    setFilterMode("all");
    setOrders([]);
    setPrintMode("label");
  };

  const handlePrintModeChange = (
    mode: PrintMode,
  ) => {
    if (
      invoiceMode === "with" &&
      mode === "a4"
    ) {
      return;
    }

    setPrintMode(mode);
  };

  const handleInvoiceModeChange = (
    mode: InvoiceMode,
  ) => {
    setInvoiceMode(mode);

    /*
     * When With Invoice is selected,
     * force Labels mode because A4 is disabled.
     */
    if (mode === "with") {
      setPrintMode("label");
    }
  };

  const handleDownloadSingle = () => {
    setFilterMode("single");
  };

  const handleDownloadMulti = () => {
    setFilterMode("multi");
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 px-4 py-12 transition-colors dark:from-black dark:to-neutral-950">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-800 dark:text-neutral-100">
            Label Cropper
          </h1>

          <p className="mt-2 text-gray-600 dark:text-neutral-300">
            Select a platform, upload your PDF and
            download sorted shipping labels
          </p>
        </div>

        <PlatformSelector
          selected={selectedPlatform}
          onSelect={handlePlatformSelect}
        />

        {template && (
          <div className="mx-auto mb-5 max-w-md rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
            <span className="font-semibold text-gray-800 dark:text-neutral-100">
              {template.name}
            </span>

            <span> — {template.specs.notes}</span>
          </div>
        )}

        <FilterOptions
          sortMode={sortMode}
          onSortModeChange={setSortMode}
          filterMode={filterMode}
          onFilterModeChange={setFilterMode}
          invoiceMode={invoiceMode}
          onInvoiceModeChange={handleInvoiceModeChange}
          printMode={printMode}
          onPrintModeChange={handlePrintModeChange}
          onDownloadSingle={handleDownloadSingle}
          onDownloadMulti={handleDownloadMulti}
          disabled={!selectedPlatform}
          disableA4={disableA4Mode}
        />

        {selectedPlatform && orders.length > 0 && (
          <div className="mx-auto mb-5 max-w-md rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/60">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-green-800 dark:text-green-300">
                  Orders detected
                </p>

                <p className="mt-1 text-xs text-green-700 dark:text-green-400">
                  Single and multiple orders can now
                  be filtered before download.
                </p>
              </div>

              <div className="rounded-full bg-green-600 px-3 py-1 text-sm font-bold text-white">
                {orders.length}
              </div>
            </div>
          </div>
        )}

        {selectedPlatform &&
        cropConfig &&
        template ? (
          <PDFCropTool
            key={selectedPlatform}
            config={cropConfig}
            printMode={printMode}
            platformName={template.name}
            invoiceMode={invoiceMode}
            sortMode={sortMode}
            filterMode={filterMode}
            onOrdersExtracted={setOrders}
          />
        ) : (
          <div className="mx-auto max-w-md rounded-lg border border-dashed border-gray-300 bg-white/70 p-8 text-center dark:border-neutral-700 dark:bg-neutral-950/70">
            <p className="text-sm font-medium text-gray-700 dark:text-neutral-200">
              Select Amazon, Flipkart or Meesho
            </p>

            <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
              PDF upload will appear after selecting
              the platform.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

// "use client";

// import { useState } from "react";

// import PlatformSelector from "@/components/PlatformSelector";
// import FilterOptions, {
//   type SortMode,
//   type InvoiceMode,
//   type PrintMode,
//   type FilterMode,
// } from "@/components/FilterOptions";
// import PDFCropTool from "@/components/PDFCropTool";

// import {
//   getPlatform,
//   type PlatformID,
// } from "@/lib/platforms";

// import { getCropConfig } from "@/lib/crop-config";
// import type { OrderData } from "@/lib/parsers/types";

// export default function HomePage() {
//   const [selectedPlatform, setSelectedPlatform] =
//     useState<PlatformID | null>(null);

//   const [sortMode, setSortMode] =
//     useState<SortMode>("sku");

//   const [filterMode, setFilterMode] =
//     useState<FilterMode>("all");

//   const [invoiceMode, setInvoiceMode] =
//     useState<InvoiceMode>("with");

//   const [printMode, setPrintMode] =
//     useState<PrintMode>("label");

//   const [orders, setOrders] = useState<OrderData[]>([]);

//   const template = selectedPlatform
//     ? getPlatform(selectedPlatform)
//     : null;

//   const cropConfig = selectedPlatform
//     ? getCropConfig(selectedPlatform)
//     : null;

//   const isLabelOnlyA4Disabled =
//     (selectedPlatform === "amazon" ||
//       selectedPlatform === "flipkart") &&
//     invoiceMode === "without";

//   const handlePlatformSelect = (
//     platformId: PlatformID
//   ) => {
//     setSelectedPlatform(platformId);
//     setFilterMode("all");
//     setOrders([]);

//     // Start every platform in label mode.
//     // Amazon and Flipkart A4 can be selected when invoice is enabled.
//     setPrintMode("label");
//   };

//   const handlePrintModeChange = (
//     mode: PrintMode
//   ) => {
//     // Amazon and Flipkart without invoice support label/mm mode only.
//     if (
//       (selectedPlatform === "amazon" ||
//         selectedPlatform === "flipkart") &&
//       invoiceMode === "without" &&
//       mode === "a4"
//     ) {
//       return;
//     }

//     setPrintMode(mode);
//   };

//   const handleInvoiceModeChange = (
//     mode: InvoiceMode
//   ) => {
//     setInvoiceMode(mode);

//     // When invoice is removed for Amazon or Flipkart,
//     // force label mode and disable A4.
//     if (
//       (selectedPlatform === "amazon" ||
//         selectedPlatform === "flipkart") &&
//       mode === "without"
//     ) {
//       setPrintMode("label");
//     }
//   };

//   const handleDownloadSingle = () => {
//     setFilterMode("single");
//   };

//   const handleDownloadMulti = () => {
//     setFilterMode("multi");
//   };

//   return (
//     <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 px-4 py-12">
//       <div className="mx-auto w-full max-w-2xl">
//         <div className="mb-8 text-center">
//           <h1 className="text-3xl font-bold text-gray-800">
//             Label Cropper
//           </h1>

//           <p className="mt-2 text-gray-600">
//             Select a platform, upload your PDF and
//             download sorted shipping labels
//           </p>
//         </div>

//         <PlatformSelector
//           selected={selectedPlatform}
//           onSelect={handlePlatformSelect}
//         />

//         {template && (
//           <div className="mx-auto mb-5 max-w-md rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600 shadow-sm">
//             <span className="font-semibold text-gray-800">
//               {template.name}
//             </span>

//             <span> — {template.specs.notes}</span>
//           </div>
//         )}

//         <FilterOptions
//           sortMode={sortMode}
//           onSortModeChange={setSortMode}
//           filterMode={filterMode}
//           onFilterModeChange={setFilterMode}
//           invoiceMode={invoiceMode}
//           onInvoiceModeChange={handleInvoiceModeChange}
//           printMode={printMode}
//           onPrintModeChange={handlePrintModeChange}
//           onDownloadSingle={handleDownloadSingle}
//           onDownloadMulti={handleDownloadMulti}
//           disabled={!selectedPlatform}
//           disableA4={isLabelOnlyA4Disabled}
//         />

//         {selectedPlatform && orders.length > 0 && (
//           <div className="mx-auto mb-5 max-w-md rounded-lg border border-green-200 bg-green-50 p-4">
//             <div className="flex items-center justify-between">
//               <div>
//                 <p className="text-sm font-semibold text-green-800">
//                   Orders detected
//                 </p>

//                 <p className="mt-1 text-xs text-green-700">
//                   Single and multiple orders can now
//                   be filtered before download.
//                 </p>
//               </div>

//               <div className="rounded-full bg-green-600 px-3 py-1 text-sm font-bold text-white">
//                 {orders.length}
//               </div>
//             </div>
//           </div>
//         )}

//         {selectedPlatform &&
//         cropConfig &&
//         template ? (
//           <PDFCropTool
//             key={selectedPlatform}
//             config={cropConfig}
//             printMode={printMode}
//             platformName={template.name}
//             invoiceMode={invoiceMode}
//             sortMode={sortMode}
//             filterMode={filterMode}
//             onOrdersExtracted={setOrders}
//           />
//         ) : (
//           <div className="mx-auto max-w-md rounded-lg border border-dashed border-gray-300 bg-white/70 p-8 text-center">
//             <p className="text-sm font-medium text-gray-700">
//               Select Amazon, Flipkart or Meesho
//             </p>

//             <p className="mt-1 text-xs text-gray-500">
//               PDF upload will appear after selecting
//               the platform.
//             </p>
//           </div>
//         )}
//       </div>
//     </main>
//   );
// }

// "use client";

// import { useState } from "react";

// import PlatformSelector from "@/components/PlatformSelector";
// import FilterOptions, {
//   type SortMode,
//   type InvoiceMode,
//   type PrintMode,
//   type FilterMode,
// } from "@/components/FilterOptions";
// import PDFCropTool from "@/components/PDFCropTool";

// import {
//   getPlatform,
//   type PlatformID,
// } from "@/lib/platforms";

// import { getCropConfig } from "@/lib/crop-config";
// import type { OrderData } from "@/lib/parsers/types";

// export default function HomePage() {
//   const [selectedPlatform, setSelectedPlatform] =
//     useState<PlatformID | null>(null);

//   const [sortMode, setSortMode] =
//     useState<SortMode>("sku");

//   const [filterMode, setFilterMode] =
//     useState<FilterMode>("all");

//   const [invoiceMode, setInvoiceMode] =
//     useState<InvoiceMode>("with");

//   const [printMode, setPrintMode] =
//     useState<PrintMode>("label");

//   const [orders, setOrders] = useState<OrderData[]>([]);

//   const template = selectedPlatform
//     ? getPlatform(selectedPlatform)
//     : null;

//   const cropConfig = selectedPlatform
//     ? getCropConfig(selectedPlatform)
//     : null;

//   const isAmazonWithoutInvoice =
//     selectedPlatform === "amazon" &&
//     invoiceMode === "without";

//   const handlePlatformSelect = (
//     platformId: PlatformID
//   ) => {
//     setSelectedPlatform(platformId);
//     setFilterMode("all");
//     setOrders([]);

//     // Start every platform in label mode.
//     // Amazon A4 can be selected manually only when invoice is enabled.
//     setPrintMode("label");
//   };

//   const handlePrintModeChange = (
//     mode: PrintMode
//   ) => {
//     // Amazon without invoice supports label/mm mode only.
//     if (
//       selectedPlatform === "amazon" &&
//       invoiceMode === "without" &&
//       mode === "a4"
//     ) {
//       return;
//     }

//     setPrintMode(mode);
//   };

//   const handleInvoiceModeChange = (
//     mode: InvoiceMode
//   ) => {
//     setInvoiceMode(mode);

//     // When invoice is removed, force label mode and disable A4.
//     if (
//       selectedPlatform === "amazon" &&
//       mode === "without"
//     ) {
//       setPrintMode("label");
//     }
//   };

//   const handleDownloadSingle = () => {
//     setFilterMode("single");
//   };

//   const handleDownloadMulti = () => {
//     setFilterMode("multi");
//   };

//   return (
//     <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 px-4 py-12">
//       <div className="mx-auto w-full max-w-2xl">
//         <div className="mb-8 text-center">
//           <h1 className="text-3xl font-bold text-gray-800">
//             Label Cropper
//           </h1>

//           <p className="mt-2 text-gray-600">
//             Select a platform, upload your PDF and
//             download sorted shipping labels
//           </p>
//         </div>

//         <PlatformSelector
//           selected={selectedPlatform}
//           onSelect={handlePlatformSelect}
//         />

//         {template && (
//           <div className="mx-auto mb-5 max-w-md rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600 shadow-sm">
//             <span className="font-semibold text-gray-800">
//               {template.name}
//             </span>

//             <span> — {template.specs.notes}</span>
//           </div>
//         )}

//         <FilterOptions
//           sortMode={sortMode}
//           onSortModeChange={setSortMode}
//           filterMode={filterMode}
//           onFilterModeChange={setFilterMode}
//           invoiceMode={invoiceMode}
//           onInvoiceModeChange={handleInvoiceModeChange}
//           printMode={printMode}
//           onPrintModeChange={handlePrintModeChange}
//           onDownloadSingle={handleDownloadSingle}
//           onDownloadMulti={handleDownloadMulti}
//           disabled={!selectedPlatform}
//           disableA4={isAmazonWithoutInvoice}
//         />

//         {selectedPlatform && orders.length > 0 && (
//           <div className="mx-auto mb-5 max-w-md rounded-lg border border-green-200 bg-green-50 p-4">
//             <div className="flex items-center justify-between">
//               <div>
//                 <p className="text-sm font-semibold text-green-800">
//                   Orders detected
//                 </p>

//                 <p className="mt-1 text-xs text-green-700">
//                   Single and multiple orders can now
//                   be filtered before download.
//                 </p>
//               </div>

//               <div className="rounded-full bg-green-600 px-3 py-1 text-sm font-bold text-white">
//                 {orders.length}
//               </div>
//             </div>
//           </div>
//         )}

//         {selectedPlatform &&
//         cropConfig &&
//         template ? (
//           <PDFCropTool
//             key={selectedPlatform}
//             config={cropConfig}
//             printMode={printMode}
//             platformName={template.name}
//             invoiceMode={invoiceMode}
//             sortMode={sortMode}
//             filterMode={filterMode}
//             onOrdersExtracted={setOrders}
//           />
//         ) : (
//           <div className="mx-auto max-w-md rounded-lg border border-dashed border-gray-300 bg-white/70 p-8 text-center">
//             <p className="text-sm font-medium text-gray-700">
//               Select Amazon, Flipkart or Meesho
//             </p>

//             <p className="mt-1 text-xs text-gray-500">
//               PDF upload will appear after selecting
//               the platform.
//             </p>
//           </div>
//         )}
//       </div>
//     </main>
//   );
// }
