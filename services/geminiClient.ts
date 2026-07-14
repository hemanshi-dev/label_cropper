export const applyFaceLockInstruction = (promptText: string) => {
  const prompt = String(promptText || '').trim();
  const instruction =
    'ABSOLUTE IDENTITY PRESERVATION: Use input image as a STRICT IDENTITY REFERENCE. Keep EXACT SAME person, IDENTICAL face, and UNCHANGED core identity. CRITICAL: Do NOT change facial structure, skin tone, age, ethnicity, gender presentation, or ANY recognizable facial traits (eyes, nose, lips, jawline, eyebrows, hairline, hair color). The output face MUST be a PERFECT MATCH to the input reference image. Only modify: outfit, pose, camera angle, lighting, and background. PRESERVE IDENTITY COMPLETELY.';

  const lower = prompt.toLowerCase();
  const alreadyLocked =
    lower.includes('absolute identity preservation') ||
    lower.includes('strict identity reference') ||
    lower.includes('exact same person') ||
    lower.includes('identical face');

  if (alreadyLocked) return prompt;
  return prompt ? `${instruction}\n${prompt}` : instruction;
};

export const generateImageWithGemini = async (base64Data: string, prompt: string) => {
  const finalPrompt = applyFaceLockInstruction(prompt);

  const response = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseImage: base64Data,
      prompt: finalPrompt,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData?.error || 'Failed to generate image via API');
  }

  const data = await response.json();
  if (!data.image) {
    throw new Error('No image returned from API');
  }

  return { 
    image: data.image,
    shippingRate: data.shippingRate 
  };
};
