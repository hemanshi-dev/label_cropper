import type { PlatformID } from "./platforms";

export interface CropRegion {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface CropConfig {
  labelSize: { width: number; height: number };
  unit: string;
  region: CropRegion;
  invoiceRegion?: CropRegion;
}

const CROP_CONFIGS: Record<PlatformID, CropConfig> = {
  flipkart: {
    labelSize: { width: 100, height: 150 },
    unit: "mm",
    region: { top: 3, left: 31, width: 38, height: 43 },
    invoiceRegion: { top: 45.9, left: 6.9, width: 88.6, height: 47.1 },
  },
  amazon: {
    labelSize: { width: 100, height: 150 },
    unit: "mm",
    region: { top: 0, left: 0.8, width: 98.6, height: 99.2 },
  },
  meesho: {
    labelSize: { width: 75, height: 125 },
    unit: "mm",
    region: { top: 1, left: 2, width: 97, height: 42 },
  },
};

export function getCropConfig(id: PlatformID): CropConfig {
  return CROP_CONFIGS[id];
}
