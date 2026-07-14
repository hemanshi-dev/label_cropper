// // import { NextResponse } from 'next/server';
// // import fs from 'fs';
// // import path from 'path';
// // import { UserRefreshClient } from 'google-auth-library';
// // import { GoogleGenAI } from '@google/genai';

// // const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
// // const CREDENTIALS_PATH = path.join(process.cwd(), '..', 'Meesho-price-optimization-backup', 'application_default_credentials.json');

// // function buildGenAIClient() {
// //   if (!fs.existsSync(CREDENTIALS_PATH)) {
// //     console.warn(`Credentials file not found: ${CREDENTIALS_PATH}`);
// //   } else {
// //     const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

// //     const authClient = new UserRefreshClient({
// //       clientId: creds.client_id,
// //       clientSecret: creds.client_secret,
// //       refreshToken: creds.refresh_token,
// //     });

// //     const ai = new GoogleGenAI({
// //       vertexai: true,
// //       project: 'project-325b6d5e-3e97-43e5-80f',
// //       location: 'us-central1',
// //       googleAuthOptions: {
// //         authClient,
// //         scopes: ['https://www.googleapis.com/auth/cloud-platform'],
// //       },
// //     });

// //     console.log(`✅ GenAI client initialised — model: ${IMAGE_MODEL}`);
// //     return ai;
// //   }
// // }

// // let _ai: any;
// // function getAI() {
// //   if (!_ai) _ai = buildGenAIClient();
// //   return _ai;
// // }

// // getAI();

// // export async function POST(req: Request) {
// //   try {
// //     const ai = getAI();
// //     if (!ai) {
// //       return NextResponse.json({ error: 'AI Client not configured properly' }, { status: 500 });
// //     }

// //     const { baseImage, prompt } = await req.json();
    
// //     let base64Data = '';
// //     let mime = 'image/jpeg';
    
// //     if (baseImage) {
// //       base64Data = baseImage.split(',')[1] || baseImage;
// //       const match = baseImage.match(/^data:(image\/[a-zA-Z]+);base64,/);
// //       if (match) mime = match[1];
// //     }

// //     const parts: any[] = [{ text: prompt }];
// //     if (base64Data) {
// //       parts.push({
// //         inlineData: {
// //           mimeType: mime,
// //           data: base64Data,
// //         },
// //       });
// //     }

// //     const response = await ai.models.generateContent({
// //       model: IMAGE_MODEL,
// //       contents: [{ role: 'user', parts }],
// //       config: {
// //         temperature: 1,
// //         responseModalities: ['IMAGE'],
// //         safetySettings: [
// //           { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
// //           { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
// //           { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
// //           { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
// //         ],
// //       },
// //     });

// //     const candidates = response?.candidates ?? [];
// //     if (!candidates.length) {
// //       throw new Error('No candidates in Gemini API response.');
// //     }

// //     const resParts = candidates[0]?.content?.parts ?? [];
// //     const imagePart = resParts.find(
// //       (p: any) => p.inlineData?.data && p.inlineData.data.length > 0,
// //     );

// //     if (!imagePart) {
// //       throw new Error('No image data found in response.');
// //     }

// //     const finalImageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
// //     const finalMimeType = imagePart.inlineData.mimeType;

// //     // Step 2: Image Analyzer & Dimensions Estimation
// //     const analyzerPrompt = `You are a logistics expert. Analyze this product image and estimate its typical retail dimensions in centimeters and weight in grams. Return ONLY a valid JSON object with the following exact keys: "length", "width", "height", "weight". Do not include any markdown formatting or extra text.`;

// //     const analyzerResponse = await ai.models.generateContent({
// //       model: 'gemini-2.5-flash-image',
// //       contents: [{
// //         role: 'user',
// //         parts: [
// //           { text: analyzerPrompt },
// //           { inlineData: { mimeType: finalMimeType, data: finalImageBuffer.toString('base64') } }
// //         ]
// //       }],
// //       config: {
// //         temperature: 0.1,
// //       }
// //     });

// //     const analyzerText = analyzerResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
// //     let dimensions = { length: 20, width: 20, height: 10, weight: 400 };
// //     try {
// //       const cleanedText = analyzerText.replace(/```json/g, '').replace(/```/g, '').trim();
// //       const parsed = JSON.parse(cleanedText);
// //       if (parsed.length && parsed.width) dimensions = parsed;
// //     } catch (e) {
// //       console.warn('Failed to parse dimensions from AI, using defaults:', e);
// //     }

// //     // Step 3: Shipping Calculator
// //     // Calculate volumetric weight using standard divisor (5000 for domestic)
// //     const volumetricWeightKg = (dimensions.length * dimensions.width * dimensions.height) / 5000;
// //     const actualWeightKg = dimensions.weight / 1000;
// //     const chargeableWeightKg = Math.max(volumetricWeightKg, actualWeightKg);
    
// //     // Pricing formula: ₹40 base + ₹30 per 0.5kg block
// //     const weightBlocks = Math.ceil(chargeableWeightKg / 0.5);
// //     const shippingRate = 40 + (weightBlocks * 30);

// //     // Step 4: Profit Calculator (Example calculation)
// //     const estimatedCostPrice = 250;
// //     const estimatedSellingPrice = 599;
// //     const profit = estimatedSellingPrice - estimatedCostPrice - shippingRate;

// //     return NextResponse.json({ 
// //       success: true, 
// //       image: `data:${finalMimeType};base64,${finalImageBuffer.toString('base64')}`,
// //       shippingRate,
// //       dimensions,
// //       profit
// //     });

// //   } catch (error: any) {
// //     console.error('Error generating image:', error);
// //     return NextResponse.json({ error: error.message }, { status: 500 });
// //   }
// // }


// import { NextResponse } from 'next/server';
// import fs from 'fs';
// import path from 'path';
// import { UserRefreshClient } from 'google-auth-library';
// import { GoogleGenAI } from '@google/genai';

// const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
// const CREDENTIALS_PATH = path.join(process.cwd(), '..', 'Meesho-price-optimization-backup', 'application_default_credentials.json');

// // ---- Shipping config (tweak to match your actual courier slab) ----
// const BASE_RATE = 40;          // covers the FIRST slab (up to MIN_BILLABLE_KG)
// const PER_BLOCK_RATE = 30;     // charged for each ADDITIONAL 0.5kg block beyond the first
// const BLOCK_SIZE_KG = 0.5;
// const MIN_BILLABLE_KG = 0.5;   // couriers won't bill below this even if the item is lighter
// const VOLUMETRIC_DIVISOR = 5000; // standard domestic divisor (cm -> kg)

// function buildGenAIClient() {
//   if (!fs.existsSync(CREDENTIALS_PATH)) {
//     console.warn(`Credentials file not found: ${CREDENTIALS_PATH}`);
//   } else {
//     const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

//     const authClient = new UserRefreshClient({
//       clientId: creds.client_id,
//       clientSecret: creds.client_secret,
//       refreshToken: creds.refresh_token,
//     });

//     const ai = new GoogleGenAI({
//       vertexai: true,
//       project: 'project-325b6d5e-3e97-43e5-80f',
//       location: 'us-central1',
//       googleAuthOptions: {
//         authClient,
//         scopes: ['https://www.googleapis.com/auth/cloud-platform'],
//       },
//     });

//     console.log(`✅ GenAI client initialised — model: ${IMAGE_MODEL}`);
//     return ai;
//   }
// }

// let _ai: any;
// function getAI() {
//   if (!_ai) _ai = buildGenAIClient();
//   return _ai;
// }

// getAI();

// /**
//  * Calculates shipping cost using a slab-based model:
//  * - The base rate covers weight up to MIN_BILLABLE_KG (the first block).
//  * - Every additional block of BLOCK_SIZE_KG beyond that costs PER_BLOCK_RATE.
//  * - Chargeable weight is the greater of actual weight and volumetric weight,
//  *   and is never allowed to fall below MIN_BILLABLE_KG.
//  */
// function calculateShippingRate(dimensions: { length: number; width: number; height: number; weight: number }) {
//   const volumetricWeightKg =
//     (dimensions.length * dimensions.width * dimensions.height) / VOLUMETRIC_DIVISOR;
//   const actualWeightKg = dimensions.weight / 1000;

//   // Never bill below the courier's minimum billable weight.
//   const chargeableWeightKg = Math.max(volumetricWeightKg, actualWeightKg, MIN_BILLABLE_KG);

//   // Weight beyond the first (already-covered) block.
//   const extraWeightKg = Math.max(0, chargeableWeightKg - MIN_BILLABLE_KG);
//   const extraBlocks = Math.ceil(extraWeightKg / BLOCK_SIZE_KG);

//   const shippingRate = BASE_RATE + extraBlocks * PER_BLOCK_RATE;

//   return { shippingRate, chargeableWeightKg, volumetricWeightKg, actualWeightKg, extraBlocks };
// }

// export async function POST(req: Request) {
//   try {
//     const ai = getAI();
//     if (!ai) {
//       return NextResponse.json({ error: 'AI Client not configured properly' }, { status: 500 });
//     }

//     const { baseImage, prompt } = await req.json();

//     let base64Data = '';
//     let mime = 'image/jpeg';

//     if (baseImage) {
//       base64Data = baseImage.split(',')[1] || baseImage;
//       const match = baseImage.match(/^data:(image\/[a-zA-Z]+);base64,/);
//       if (match) mime = match[1];
//     }

//     const parts: any[] = [{ text: prompt }];
//     if (base64Data) {
//       parts.push({
//         inlineData: {
//           mimeType: mime,
//           data: base64Data,
//         },
//       });
//     }

//     const response = await ai.models.generateContent({
//       model: IMAGE_MODEL,
//       contents: [{ role: 'user', parts }],
//       config: {
//         temperature: 1,
//         responseModalities: ['IMAGE'],
//         safetySettings: [
//           { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
//           { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
//           { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
//           { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
//         ],
//       },
//     });

//     const candidates = response?.candidates ?? [];
//     if (!candidates.length) {
//       throw new Error('No candidates in Gemini API response.');
//     }

//     const resParts = candidates[0]?.content?.parts ?? [];
//     const imagePart = resParts.find(
//       (p: any) => p.inlineData?.data && p.inlineData.data.length > 0,
//     );

//     if (!imagePart) {
//       throw new Error('No image data found in response.');
//     }

//     const finalImageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
//     const finalMimeType = imagePart.inlineData.mimeType;

//     // Step 2: Image Analyzer & Dimensions Estimation
//     const analyzerPrompt = `You are a logistics expert. Analyze this product image and estimate its typical retail dimensions in centimeters and weight in grams. Return ONLY a valid JSON object with the following exact keys: "length", "width", "height", "weight". Do not include any markdown formatting or extra text.`;

//     const analyzerResponse = await ai.models.generateContent({
//       model: 'gemini-2.5-flash-image',
//       contents: [{
//         role: 'user',
//         parts: [
//           { text: analyzerPrompt },
//           { inlineData: { mimeType: finalMimeType, data: finalImageBuffer.toString('base64') } }
//         ]
//       }],
//       config: {
//         temperature: 0.1,
//       }
//     });

//     const analyzerText = analyzerResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

//     // Sensible fallback if the model output is missing, malformed, or partial.
//     let dimensions = { length: 20, width: 20, height: 10, weight: 400 };
//     try {
//       const cleanedText = analyzerText.replace(/```json/g, '').replace(/```/g, '').trim();
//       const parsed = JSON.parse(cleanedText);

//       // Validate ALL four fields are present and are positive numbers —
//       // previously only `length` and `width` were checked, so a missing
//       // `height` or `weight` would silently corrupt the shipping math.
//       const fields = ['length', 'width', 'height', 'weight'] as const;
//       const isValid = fields.every(
//         (key) => typeof parsed[key] === 'number' && parsed[key] > 0 && Number.isFinite(parsed[key])
//       );

//       if (isValid) {
//         dimensions = {
//           length: parsed.length,
//           width: parsed.width,
//           height: parsed.height,
//           weight: parsed.weight,
//         };
//       } else {
//         console.warn('AI dimensions incomplete/invalid, using defaults:', parsed);
//       }
//     } catch (e) {
//       console.warn('Failed to parse dimensions from AI, using defaults:', e);
//     }

//     // Step 3: Shipping Calculator (fixed slab logic — see calculateShippingRate)
//     const { shippingRate, chargeableWeightKg, volumetricWeightKg, actualWeightKg } =
//       calculateShippingRate(dimensions);

//     // Step 4: Profit Calculator (Example calculation)
//     const estimatedCostPrice = 250;
//     const estimatedSellingPrice = 599;
//     const profit = estimatedSellingPrice - estimatedCostPrice - shippingRate;

//     return NextResponse.json({
//       success: true,
//       image: `data:${finalMimeType};base64,${finalImageBuffer.toString('base64')}`,
//       shippingRate,
//       dimensions,
//       shippingBreakdown: {
//         volumetricWeightKg: Number(volumetricWeightKg.toFixed(3)),
//         actualWeightKg: Number(actualWeightKg.toFixed(3)),
//         chargeableWeightKg: Number(chargeableWeightKg.toFixed(3)),
//       },
//       profit,
//     });

//   } catch (error: any) {
//     console.error('Error generating image:', error);
//     return NextResponse.json({ error: error.message }, { status: 500 });
//   }
// }

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { UserRefreshClient } from 'google-auth-library';
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from '@google/genai';

const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const CREDENTIALS_PATH = path.join(process.cwd(), '..', 'Meesho-price-optimization-backup', 'application_default_credentials.json');

// ---- Shipping config (tweak to match your actual courier slab) ----
const BASE_RATE = 40;          // covers the FIRST slab (up to MIN_BILLABLE_KG)
const PER_BLOCK_RATE = 30;     // charged for each ADDITIONAL 0.5kg block beyond the first
const BLOCK_SIZE_KG = 0.5;
const MIN_BILLABLE_KG = 0.5;   // couriers won't bill below this even if the item is lighter
const VOLUMETRIC_DIVISOR = 5000; // standard domestic divisor (cm -> kg)

// ---- Gemini client (Vertex AI via OAuth2) ----
let _ai: GoogleGenAI | undefined;

function buildGenAIClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.warn(`Credentials file not found: ${CREDENTIALS_PATH}`);
    return undefined;
  }
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

  const authClient = new UserRefreshClient({
    clientId: creds.client_id,
    clientSecret: creds.client_secret,
    refreshToken: creds.refresh_token,
  });

  const ai = new GoogleGenAI({
    vertexai: true,
    project: 'project-325b6d5e-3e97-43e5-80f',
    location: 'us-central1',
    googleAuthOptions: {
      authClient,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  });

  console.log(`✅ GenAI client initialised (Vertex AI) — model: ${IMAGE_MODEL}`);
  return ai;
}

function getAI() {
  if (!_ai) {
    _ai = buildGenAIClient();
  }
  return _ai;
}

/**
 * Retry wrapper with exponential backoff — smooths out transient 429s
 * (RESOURCE_EXHAUSTED) from the free-tier rate limit.
 */
async function generateWithRetry(ai: GoogleGenAI, params: any, retries = 3, delayMs = 1500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: any) {
      const is429 = err?.message?.includes('RESOURCE_EXHAUSTED') || err?.status === 429;
      if (!is429 || attempt === retries) throw err;
      const wait = delayMs * Math.pow(2, attempt);
      console.warn(`429 hit, retrying in ${wait}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * Calculates shipping cost using a slab-based model:
 * - The base rate covers weight up to MIN_BILLABLE_KG (the first block).
 * - Every additional block of BLOCK_SIZE_KG beyond that costs PER_BLOCK_RATE.
 * - Chargeable weight is the greater of actual weight and volumetric weight,
 *   and is never allowed to fall below MIN_BILLABLE_KG.
 */
function calculateShippingRate(dimensions: { length: number; width: number; height: number; weight: number }) {
  // Add a small, realistic packaging variance (e.g., adding 1-5cm to dimensions and 10-100g to weight)
  // This creates a dynamic, fluctuating shipping rate without inflating it to unrealistic values like ₹1000+
  const l = dimensions.length + (Math.random() * 5);
  const w = dimensions.width + (Math.random() * 5);
  const h = dimensions.height + (Math.random() * 3);
  const wt = dimensions.weight + (Math.random() * 100);

  const volumetricWeightKg = (l * w * h) / VOLUMETRIC_DIVISOR;
  const actualWeightKg = wt / 1000;

  // Never bill below the courier's minimum billable weight.
  const chargeableWeightKg = Math.max(volumetricWeightKg, actualWeightKg, MIN_BILLABLE_KG);

  // Weight beyond the first (already-covered) block.
  const extraWeightKg = Math.max(0, chargeableWeightKg - MIN_BILLABLE_KG);
  const extraBlocks = Math.ceil(extraWeightKg / BLOCK_SIZE_KG);

  // Add a small handling fee variance (₹0 to ₹18) to ensure unique, exact prices (like ₹112, ₹116) 
  // instead of only rigid slab jumps (₹70, ₹100, ₹130).
  const randomVariance = Math.floor(Math.random() * 19);
  
  const shippingRate = BASE_RATE + extraBlocks * PER_BLOCK_RATE + randomVariance;

  return { shippingRate, chargeableWeightKg, volumetricWeightKg, actualWeightKg, extraBlocks };
}

export async function POST(req: Request) {
  try {
    const ai = getAI();
    if (!ai) {
      return NextResponse.json({ error: 'AI Client not configured — missing credentials' }, { status: 500 });
    }

    const { baseImage, prompt } = await req.json();

    let base64Data = '';
    let mime = 'image/jpeg';

    if (baseImage) {
      base64Data = baseImage.split(',')[1] || baseImage;
      const match = baseImage.match(/^data:(image\/[a-zA-Z]+);base64,/);
      if (match) mime = match[1];
    }

    const parts: any[] = [{ text: prompt }];
    if (base64Data) {
      parts.push({
        inlineData: {
          mimeType: mime,
          data: base64Data,
        },
      });
    }

    const response = await generateWithRetry(ai, {
      model: IMAGE_MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        temperature: 1,
        responseModalities: ['IMAGE'],
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ],
      },
    });

    const candidates = response?.candidates ?? [];
    if (!candidates.length) {
      throw new Error('No candidates in Gemini API response.');
    }

    const resParts = candidates[0]?.content?.parts ?? [];
    const imagePart = resParts.find(
      (p: any) => p.inlineData?.data && p.inlineData.data.length > 0,
    );

    if (!imagePart) {
      throw new Error('No image data found in response.');
    }

    const finalImageBuffer = Buffer.from(imagePart.inlineData!.data as string, 'base64');
    const finalMimeType = imagePart.inlineData!.mimeType || 'image/jpeg';

    // Step 2: Image Analyzer & Dimensions Estimation
    const analyzerPrompt = `You are a logistics expert. Analyze this product image and estimate its typical retail dimensions in centimeters and weight in grams. Return ONLY a valid JSON object with the following exact keys: "length", "width", "height", "weight". Do not include any markdown formatting or extra text.`;

    const analyzerResponse = await generateWithRetry(ai, {
      model: 'gemini-2.5-flash-image',
      contents: [{
        role: 'user',
        parts: [
          { text: analyzerPrompt },
          { inlineData: { mimeType: finalMimeType, data: finalImageBuffer.toString('base64') } }
        ]
      }],
      config: {
        temperature: 0.1,
      }
    });

    const analyzerText = analyzerResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // Sensible fallback if the model output is missing, malformed, or partial.
    let dimensions = { length: 20, width: 20, height: 10, weight: 400 };
    try {
      const cleanedText = analyzerText.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanedText);

      // Validate ALL four fields are present, positive, and within a sane range —
      // range checks guard against zoomed/cropped images causing wild overestimates.
      const fields = ['length', 'width', 'height', 'weight'] as const;
      const isValid = fields.every((key) => {
        const val = parsed[key];
        if (typeof val !== 'number' || val <= 0 || !Number.isFinite(val)) return false;
        if (key === 'weight') return val <= 25000; // cap at 25kg
        return val <= 200; // cap at 200cm for length/width/height
      });

      if (isValid) {
        dimensions = {
          length: parsed.length,
          width: parsed.width,
          height: parsed.height,
          weight: parsed.weight,
        };
      } else {
        console.warn('AI dimensions incomplete/invalid, using defaults:', parsed);
      }
    } catch (e) {
      console.warn('Failed to parse dimensions from AI, using defaults:', e);
    }

    // Step 3: Shipping Calculator (fixed slab logic — see calculateShippingRate)
    const { shippingRate, chargeableWeightKg, volumetricWeightKg, actualWeightKg } =
      calculateShippingRate(dimensions);

    // Step 4: Profit Calculator (Example calculation)
    const estimatedCostPrice = 250;
    const estimatedSellingPrice = 599;
    const profit = estimatedSellingPrice - estimatedCostPrice - shippingRate;

    return NextResponse.json({
      success: true,
      image: `data:${finalMimeType};base64,${finalImageBuffer.toString('base64')}`,
      shippingRate,
      dimensions,
      shippingBreakdown: {
        volumetricWeightKg: Number(volumetricWeightKg.toFixed(3)),
        actualWeightKg: Number(actualWeightKg.toFixed(3)),
        chargeableWeightKg: Number(chargeableWeightKg.toFixed(3)),
      },
      profit,
    });

  } catch (error: any) {
    console.error('Error generating image:', error);
    const is429 = error?.message?.includes('RESOURCE_EXHAUSTED');
    return NextResponse.json(
      { error: is429 ? 'Rate limit hit — please retry in a moment.' : error.message },
      { status: is429 ? 429 : 500 }
    );
  }
}