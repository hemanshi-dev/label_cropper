import type { OrderData } from "./types";
import type { SortMode } from "@/components/FilterOptions";

export function sortOrders(orders: OrderData[], sortBy: SortMode): OrderData[] {
  return [...orders].sort((a, b) => {
    switch (sortBy) {
      case "sku":
        return a.sku.localeCompare(b.sku);
      case "courier":
        return (a.courier ?? "").localeCompare(b.courier ?? "");
      default:
        return 0;
    }
  });
}
