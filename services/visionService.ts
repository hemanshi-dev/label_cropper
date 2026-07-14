const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = src;
});

import { generateImageWithGemini } from './geminiClient';

const themeColors: Record<string, [string, string]> = {
  studio: ['#ffffff', '#e5e7eb'],
  marble: ['#f8fafc', '#cbd5e1'],
  wood: ['#d6a76c', '#754c24'],
  outdoor: ['#d9f99d', '#86efac'],
  urban: ['#cbd5e1', '#64748b'],
  pastel: ['#fce7f3', '#ddd6fe'],
};

export const generateProductBackground = async (dataUrl: string, theme: string): Promise<string> => {
  try {
    const prompt = `Create a professional product photo. The product is provided. Place it in a setting described as: ${theme}. Make it photorealistic.`;
    const result = await generateImageWithGemini(dataUrl, prompt);
    return result.image;
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
};

export const analyzeProductImage = async (_dataUrl?: string): Promise<string[]> => [
  'E-commerce Product', 'Product Photography', 'Online Listing', 'Retail', 'Catalog'
];
