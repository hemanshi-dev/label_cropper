"use client";

import React, { useState } from 'react';
import SynthesizerModule from '@/components/SynthesizerModule';
import { ImageVariant } from '@/types';
import { clearAllVariantsFromDB } from '@/services/imageService';

export default function SynthesizerPage() {
  const [variants, setVariants] = useState<ImageVariant[]>([]);

  const handleVariantsGenerated = (newVariants: ImageVariant[], autoNavigate: boolean) => {
    setVariants((prev) => [...newVariants, ...prev]);
  };

  const handleClearHistory = async () => {
    await clearAllVariantsFromDB();
    setVariants([]);
    return true;
  };

  return (
    <main className="synthesizer-theme min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 p-8 dark:from-black dark:to-neutral-950">
      <div className="max-w-6xl mx-auto">
        <SynthesizerModule
          existingVariants={variants}
          onVariantsGenerated={handleVariantsGenerated}
          onClearHistory={handleClearHistory}
        />
      </div>
    </main>
  );
}
