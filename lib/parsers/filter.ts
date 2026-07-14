import type { OrderData } from "./types";
import type { FilterMode } from "@/components/FilterOptions";

function isMultiOrder(order: OrderData): boolean {
  const platform = String(
    order.platform ?? "",
  ).toLowerCase();

  /*
   * Amazon and Flipkart:
   * Qty 1   => Single
   * Qty > 1 => Multi
   *
   * Meesho:
   * Keep the existing parser result unchanged.
   */
  if (
    platform === "amazon" ||
    platform === "flipkart"
  ) {
    const quantity = Number(order.quantity ?? 0);
    return quantity > 1;
  }

  return Boolean(order.isMultiOrder);
}

export function filterOrders(
  orders: OrderData[],
  filter: FilterMode,
): OrderData[] {
  switch (filter) {
    case "single":
      return orders.filter(
        (order) => !isMultiOrder(order),
      );

    case "multi":
      return orders.filter(
        (order) => isMultiOrder(order),
      );

    case "all":
    default:
      return [...orders];
  }
}

// import type { OrderData } from "./types";
// import type { FilterMode } from "@/components/FilterOptions";

// function isMultiOrder(order: OrderData): boolean {
//   const platform = String(order.platform ?? "").toLowerCase();

//   /*
//    * Amazon:
//    * Qty 1     => Single
//    * Qty > 1   => Multi
//    *
//    * Flipkart / Meesho:
//    * Keep their existing parser result.
//    */
//   if (platform === "amazon") {
//     const quantity = Number(order.quantity ?? 0);

//     return quantity > 1;
//   }

//   return Boolean(order.isMultiOrder);
// }

// export function filterOrders(
//   orders: OrderData[],
//   filter: FilterMode,
// ): OrderData[] {
//   switch (filter) {
//     case "single":
//       return orders.filter((order) => !isMultiOrder(order));

//     case "multi":
//       return orders.filter((order) => isMultiOrder(order));

//     case "all":
//     default:
//       return [...orders];
//   }
// }

// import type { OrderData } from "./types";
// import type { FilterMode } from "@/components/FilterOptions";

// export function filterOrders(orders: OrderData[], filter: FilterMode): OrderData[] {
//   switch (filter) {
//     case "single":
//       return orders.filter((o) => !o.isMultiOrder);
//     case "multi":
//       return orders.filter((o) => o.isMultiOrder);
//     case "all":
//     default:
//       return orders;
//   }
// }
