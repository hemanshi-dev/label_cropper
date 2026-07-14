export type PlatformID = "amazon" | "flipkart" | "meesho";

export interface CropTemplate {
  id: PlatformID;
  name: string;
  color: string;
  bgHover: string;
  borderActive: string;
  textActive: string;
  icon: string;
  logo: string;
  specs: {
    labelWidth: number;
    labelHeight: number;
    unit: string;
    dpi: number;
    notes: string;
  };
}

export const PLATFORMS: CropTemplate[] = [
  {
    id: "amazon",
    name: "Amazon",
    color: "bg-orange-500",
    bgHover: "hover:bg-orange-600",
    borderActive: "border-orange-500",
    textActive: "text-orange-600",
    icon: "A",
    logo: "/images/Amazon_icon.png",
    specs: {
      labelWidth: 100,
      labelHeight: 150,
      unit: "mm",
      dpi: 300,
      notes: "100mm × 150mm",
    },
  },
  {
    id: "flipkart",
    name: "Flipkart",
    color: "bg-blue-600",
    bgHover: "hover:bg-blue-700",
    borderActive: "border-blue-600",
    textActive: "text-blue-600",
    icon: "F",
    logo: "/images/flipkart_icon.png",
    specs: {
      labelWidth: 100,
      labelHeight: 150,
      unit: "mm",
      dpi: 300,
      notes: "100mm × 150mm",
    },
  },
  {
    id: "meesho",
    name: "Meesho",
    color: "bg-pink-600",
    bgHover: "hover:bg-pink-700",
    borderActive: "border-pink-600",
    textActive: "text-pink-600",
    icon: "M",
    logo: "/images/meesho_icon.png",
    specs: {
      labelWidth: 75,
      labelHeight: 125,
      unit: "mm",
      dpi: 300,
      notes: "75mm × 125mm",
    },
  },
];

export function getPlatform(id: PlatformID): CropTemplate | undefined {
  return PLATFORMS.find((p) => p.id === id);
}

export function getPlatformId(name: string): PlatformID | undefined {
  const platform = PLATFORMS.find((p) => p.name.toLowerCase() === name.toLowerCase());
  return platform?.id;
}
