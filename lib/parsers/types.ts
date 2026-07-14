import type { PlatformID } from "../platforms";

export interface OrderData {
  page: number;
  platform: PlatformID;
  orderId: string;
  invoiceNumber: string;
  sku: string;
  productName: string;
  quantity: number;
  courier: string | null;
  awbNumber: string | null;
  customerName: string;
  paymentMode: string | null;
  isMultiOrder: boolean;
}

export type Parser = (pageText: string, pageIndex: number) => OrderData | null;
