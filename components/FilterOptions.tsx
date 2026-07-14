"use client";

import type { ReactNode } from "react";

export type SortMode = "sku" | "courier";
export type FilterMode = "all" | "single" | "multi";
export type InvoiceMode = "with" | "without";
export type PrintMode = "label" | "a4";

interface FilterOptionsProps {
  sortMode: SortMode;
  onSortModeChange: (value: SortMode) => void;

  filterMode: FilterMode;
  onFilterModeChange: (value: FilterMode) => void;

  invoiceMode: InvoiceMode;
  onInvoiceModeChange: (value: InvoiceMode) => void;

  printMode: PrintMode;
  onPrintModeChange: (value: PrintMode) => void;

  onDownloadSingle: () => void;
  onDownloadMulti: () => void;

  disabled?: boolean;
  disableA4?: boolean;
}

export default function FilterOptions({
  sortMode,
  onSortModeChange,
  filterMode,
  onFilterModeChange,
  invoiceMode,
  onInvoiceModeChange,
  printMode,
  onPrintModeChange,
  onDownloadSingle,
  onDownloadMulti,
  disabled = false,
  disableA4 = false,
}: FilterOptionsProps) {
  return (
    <div className="mx-auto mb-6 max-w-md space-y-5">
      <Group label="Sort by">
        <ToggleButton
          active={sortMode === "sku"}
          onClick={() => onSortModeChange("sku")}
          disabled={disabled}
        >
          SKU wise
        </ToggleButton>

        <ToggleButton
          active={sortMode === "courier"}
          onClick={() => onSortModeChange("courier")}
          disabled={disabled}
        >
          By Courier
        </ToggleButton>
      </Group>

      <Group label="Filter">
        <ToggleButton
          active={filterMode === "all"}
          onClick={() => onFilterModeChange("all")}
          disabled={disabled}
        >
          All Orders
        </ToggleButton>

        <ToggleButton
          active={filterMode === "single"}
          onClick={() => onFilterModeChange("single")}
          disabled={disabled}
        >
          Single Only
        </ToggleButton>

        <ToggleButton
          active={filterMode === "multi"}
          onClick={() => onFilterModeChange("multi")}
          disabled={disabled}
        >
          Multi Only
        </ToggleButton>
      </Group>

      <Group label="Invoice">
        <ToggleButton
          active={invoiceMode === "with"}
          onClick={() => onInvoiceModeChange("with")}
          disabled={disabled}
        >
          With Invoice
        </ToggleButton>

        <ToggleButton
          active={invoiceMode === "without"}
          onClick={() => onInvoiceModeChange("without")}
          disabled={disabled}
        >
          Without Invoice
        </ToggleButton>
      </Group>

      <Group label="Print Mode">
        <ToggleButton
          active={printMode === "label"}
          onClick={() => onPrintModeChange("label")}
          disabled={disabled}
        >
          Labels (mm)
        </ToggleButton>

        <ToggleButton
          active={printMode === "a4"}
          onClick={() => onPrintModeChange("a4")}
          disabled={disabled || disableA4}
        >
          A4 Mode
        </ToggleButton>
      </Group>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onDownloadSingle}
          disabled={disabled}
          className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Single Orders
        </button>

        <button
          type="button"
          onClick={onDownloadMulti}
          disabled={disabled}
          className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Multi Orders
        </button>
      </div>
    </div>
  );
}

function Group({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-neutral-400">
        {label}
      </p>

      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
        disabled
          ? "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400 opacity-60 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-500"
          : active
            ? "cursor-pointer border-indigo-500 bg-indigo-50 text-indigo-700 shadow-sm dark:bg-neutral-900 dark:text-indigo-300"
            : "cursor-pointer border-gray-200 bg-white text-gray-600 hover:border-gray-400 hover:bg-gray-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:bg-neutral-900"
      }`}
    >
      {children}
    </button>
  );
}
