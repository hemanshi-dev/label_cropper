export interface ImageVariant {
  id: string;
  dataUrl: string;
  blobUrl?: string; // Short-lived unique session URL for references
  config: OverlayConfig;
  detectedPrice?: number;
  detectedShipping?: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage?: string;
  timestamp?: number;
  tags?: string[]; // New: AI generated keywords for SEO
  originalPrice?: number;
  reducedBy?: number;
}

export interface OverlayConfig {
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  x: number;
  y: number;
  rotation: number;
  // New features
  batchNumber?: string;
  showDate?: boolean;
  textureIntensity?: number;
  exportFormat?: 'image/jpeg' | 'image/png';
  upscaleFactor?: number;
  opacity?: number;
}

export enum AppSection {
  SYNTHESIZER = 'synthesizer',
  VALIDATOR = 'validator',
  INSIGHTS = 'insights',
  SETTINGS = 'settings'
}

export interface ValidationSummary {
  total: number;
  success: number;
  failed: number;
  errors: Array<{
    variantId: string;
    error: string;
  }>;
}

export interface OptimizationResult {
  clusterId: string;
  averageShipping: number;
  variantCount: number;
  bestVariantId: string;
}
