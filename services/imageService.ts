import { OverlayConfig, ImageVariant } from '../types';
import { FONTS, COLORS } from '../constants';
import { generateImageWithGemini } from './geminiClient';

// --- Persistent Storage (IndexedDB) Setup ---
const DB_NAME = 'MeeshoSuiteDB';
const STORE_NAME = 'ImageVariants';

const getDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const saveVariantToDB = async (variant: ImageVariant) => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(variant);
    transaction.oncomplete = () => {
      db.close();
      resolve(true);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
};

export const getAllVariantsFromDB = async (): Promise<ImageVariant[]> => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      resolve(request.result || []);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
};

export const clearAllVariantsFromDB = async () => {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    transaction.oncomplete = () => {
      db.close();
      resolve(true);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
};

// --- Adversarial Image Generation (Anti-Duplicate Engine) ---

export const generateVariant = async (
  baseImage: HTMLImageElement,
  productName: string,
  id: string,
  options: { 
    batchNumber?: string; 
    showDate?: boolean; 
    textureIntensity?: number;
    exportFormat?: 'image/jpeg' | 'image/png';
    upscaleFactor?: number;
    opacity?: number;
    tags?: string[];
    marketCloaking?: boolean; // New toggle for aggressive variation
    originalPrice?: number;
    optimizedPrice?: number;
    reducedBy?: number;
    shippingRate?: number;
    theme?: string;
  } = {}
): Promise<ImageVariant> => {
  // Call the backend API to generate a new variation
  let dataUrl = '';
  try {
    const base64Src = baseImage.src.startsWith('data:') ? baseImage.src : await (async () => {
      const canvas = document.createElement('canvas');
      canvas.width = baseImage.naturalWidth || baseImage.width;
      canvas.height = baseImage.naturalHeight || baseImage.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(baseImage, 0, 0);
      return canvas.toDataURL('image/jpeg');
    })();

    const activeTheme = options.theme || (options.marketCloaking ? 'aggressive variation' : 'subtle variation');

    const prompt = `Create a highly realistic and professional e-commerce variation of this product. Slightly alter the lighting, angle, or background subtleties to make it unique but keep the exact same core product. Theme: ${activeTheme}`;
    const result = await generateImageWithGemini(base64Src, prompt);
    dataUrl = result.image;
    
    if (result.shippingRate) {
      options.shippingRate = result.shippingRate;
    }

  } catch (error: any) {
    console.error('API Error during variation:', error);
    const variant: ImageVariant = {
      id,
      dataUrl: '',
      config: { text: productName, fontFamily: '', fontSize: 0, color: '', x: 0, y: 0, rotation: 0 },
      status: 'failed',
      errorMessage: error.message || 'Image not generated',
      timestamp: Date.now(),
    };
    return variant;
  }

  // Now, load the generated image (either from API or fallback) onto a canvas to add overlays
  const canvas = document.createElement('canvas');
  const scale = options.upscaleFactor || 1;
  const resultImg = await (async () => {
    return new Promise<HTMLImageElement>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = dataUrl;
    });
  })();

  canvas.width = resultImg.naturalWidth * scale;
  canvas.height = resultImg.naturalHeight * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Apply a vibrant gradient frame if the shipping rate is very cheap (<= 106)
  const isCheapShipping = options.shippingRate && options.shippingRate <= 106;
  if (isCheapShipping) {
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    const gradientColors = [
      ['#FF0080', '#7928CA'], // Pink to Purple
      ['#FF4D4D', '#F9CB28'], // Red to Yellow
      ['#00DFD8', '#007CF0'], // Teal to Blue
      ['#FF0080', '#007CF0'], // Pink to Blue
      ['#11998E', '#38EF7D']  // Dark Green to Light Green
    ];
    const colors = gradientColors[Math.floor(Math.random() * gradientColors.length)];
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(1, colors[1]);
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw the image smaller inside the frame
    const padding = Math.floor(canvas.width * 0.06);
    ctx.drawImage(resultImg, padding, padding, canvas.width - padding * 2, canvas.height - padding * 2);
  } else {
    // Standard full-bleed drawing
    ctx.drawImage(resultImg, 0, 0, canvas.width, canvas.height);
  }

  // --- Step 4: Overlay Generation ---
  const config: OverlayConfig = {
    text: productName,
    fontFamily: FONTS[Math.floor(Math.random() * FONTS.length)],
    fontSize: (Math.random() * 0.4 + 0.4) * scale * 30, // Responsive size
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    x: (Math.random() * (canvas.width * 0.8) + (canvas.width * 0.1)),
    y: (Math.random() * (canvas.height * 0.8) + (canvas.height * 0.1)),
    rotation: Math.random() * Math.PI * 2,
    batchNumber: options.batchNumber,
    showDate: options.showDate,
    textureIntensity: options.textureIntensity,
    exportFormat: options.exportFormat || 'image/jpeg',
    upscaleFactor: scale,
    opacity: options.opacity ?? 0.03,
  };

  ctx.save();
  ctx.translate(config.x, config.y);
  ctx.rotate(config.rotation);
  ctx.font = `bold ${config.fontSize}px ${config.fontFamily}`;
  ctx.fillStyle = config.color;
  ctx.globalAlpha = config.opacity ?? 0.03; 
  ctx.textAlign = 'center';
  ctx.fillText(config.text, 0, 0);
  ctx.restore();

  // The selling price is part of the exported image and is rendered last so it
  // stays readable and exactly matches the value saved with this variant.
  if (options.optimizedPrice !== undefined) {
    const priceText = `₹${options.optimizedPrice.toLocaleString('en-IN')}`;
    const reductionText = options.reducedBy ? `₹${options.reducedBy.toLocaleString('en-IN')} OFF` : '';
    const priceFontSize = Math.max(22, Math.round(canvas.width * 0.055));
    const paddingX = Math.round(priceFontSize * 0.65);
    const paddingY = Math.round(priceFontSize * 0.4);
    ctx.save();
    ctx.font = `800 ${priceFontSize}px Arial, sans-serif`;
    const labelWidth = Math.ceil(ctx.measureText(priceText).width + paddingX * 2);
    const labelHeight = priceFontSize + paddingY * 2;
    const x = Math.round(canvas.width * 0.04);
    const y = canvas.height - labelHeight - Math.round(canvas.height * 0.04);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.strokeStyle = 'rgba(17, 24, 39, 0.18)';
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    ctx.roundRect(x, y, labelWidth, labelHeight, Math.round(labelHeight * 0.22));
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(priceText, x + paddingX, y + labelHeight / 2);
    if (reductionText) {
      const offFontSize = Math.max(12, Math.round(priceFontSize * 0.42));
      ctx.font = `800 ${offFontSize}px Arial, sans-serif`;
      const offWidth = Math.ceil(ctx.measureText(reductionText).width + paddingX);
      const offHeight = offFontSize + Math.round(paddingY * 0.7);
      const offX = x;
      const offY = Math.max(Math.round(canvas.height * 0.03), y - offHeight - Math.round(5 * scale));
      ctx.fillStyle = '#15803d';
      ctx.beginPath();
      ctx.roundRect(offX, offY, offWidth, offHeight, Math.round(offHeight * 0.25));
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(reductionText, offX + paddingX / 2, offY + offHeight / 2);
    }
    ctx.restore();
  }

  // JPEG at 82% keeps good catalogue quality with a substantially smaller payload.
  const format = options.exportFormat || 'image/jpeg';
  const quality = format === 'image/jpeg' ? 0.82 : 0.9;
  const finalDataUrl = canvas.toDataURL(format, quality);
  
  const variant: ImageVariant = {
    id,
    dataUrl: finalDataUrl,
    blobUrl: finalDataUrl,
    config,
    status: 'completed',
    timestamp: Date.now(),
    tags: options.tags,
    originalPrice: options.originalPrice,
    detectedPrice: options.optimizedPrice,
    reducedBy: options.reducedBy,
    detectedShipping: options.shippingRate
  };

  await saveVariantToDB(variant);
  return variant;
};

export const loadImage = (url: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
};

export const downloadImage = async (dataUrl: string, filename: string) => {
  if (!dataUrl) return;
  try {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    console.error('Standard download failed', err);
  }
};

export const exportToCSV = (variants: ImageVariant[]) => {
  const headers = [
    'Amazon Link Ref', 'Flipkart Link Ref', 'Meesho Link Ref', 'Local Filename', 'Product Title', 'Batch Code', 'Optimized Price', 'Shipping Fee', 'Keywords', 'Variant UUID'
  ];

  const rows = variants.map(v => {
    const shortId = v.id.split('-').pop();
    const ext = v.config.exportFormat === 'image/png' ? 'png' : 'jpg';
    const filename = `cloaked_opt_${shortId}.${ext}`;
    return [
      `cdn://${filename}`, `cdn://${filename}`, `cdn://${filename}`, filename, v.config.text, v.config.batchNumber || 'N/A', v.detectedPrice || 'N/A', v.detectedShipping !== undefined ? v.detectedShipping : 'N/A', v.tags ? v.tags.join('; ') : '', v.id
    ];
  });

  const csvContent = [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `listing_batch_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
};
