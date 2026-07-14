"use client";
import React, { useState, useRef, useEffect } from 'react';
import { generateVariant, loadImage, downloadImage } from '../services/imageService';
import { analyzeProductImage, generateProductBackground } from '../services/visionService';
import { ImageVariant } from '../types';

interface SynthesizerModuleProps {
  onVariantsGenerated: (variants: ImageVariant[], autoNavigate: boolean) => void;
  existingVariants: ImageVariant[];
  onClearHistory: () => Promise<boolean>;
}

const BG_PRESETS = [
  { id: 'studio', name: 'Studio White', icon: '⚪' },
  { id: 'marble', name: 'Luxury Marble', icon: '🏛️' },
  { id: 'wood', name: 'Natural Wood', icon: '🪵' },
  { id: 'outdoor', name: 'Garden / Outdoor', icon: '🌿' },
  { id: 'urban', name: 'Urban Lifestyle', icon: '🏙️' },
  { id: 'pastel', name: 'Minimal Pastel', icon: '🎨' },
];

const SynthesizerModule: React.FC<SynthesizerModuleProps> = ({ onVariantsGenerated, existingVariants, onClearHistory }) => {
  const [baseImage, setBaseImage] = useState<string | null>(null);
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [generatedMasters, setGeneratedMasters] = useState<string[]>([]);
  
  const [productName, setProductName] = useState('');
  const [variantCount, setVariantCount] = useState(10);
  const [batchNumber, setBatchNumber] = useState(`B-${Math.floor(1000 + Math.random() * 9000)}`);
  const [showDate, setShowDate] = useState(true);
  const [textureIntensity, setTextureIntensity] = useState(0.08);
  const [opacity, setOpacity] = useState(0.04); 
  const [marketCloaking, setMarketCloaking] = useState(true);
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGeneratingBG, setIsGeneratingBG] = useState(false);
  const [progress, setProgress] = useState(0);
  const [autoNavigate, setAutoNavigate] = useState(false); 
  const [clearAfterDownload, setClearAfterDownload] = useState(false);
  
  const [tags, setTags] = useState<string[]>([]);
  const [isTagging, setIsTagging] = useState(false);
  
  const [exportFormat, setExportFormat] = useState<'image/jpeg' | 'image/png'>('image/jpeg');
  const [upscaleFactor, setUpscaleFactor] = useState<number>(1);
  
  const [lastBatch, setLastBatch] = useState<ImageVariant[]>([]);
  const [exportProgress, setExportProgress] = useState(0);
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');
  const [selectedTheme, setSelectedTheme] = useState('');
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLastBatch(existingVariants);
  }, [existingVariants]);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const dataUrl = event.target?.result as string;
        setBaseImage(dataUrl);
        setOriginalImage(dataUrl);
        setGeneratedMasters([]);
        triggerAITagging(dataUrl);
      };
      reader.readAsDataURL(file);
    }
  };

  const triggerAITagging = async (image: string) => {
    setIsTagging(true);
    try {
      const suggestedTags = await analyzeProductImage(image);
      setTags(suggestedTags);
      if (suggestedTags.length > 0 && !productName) {
        setProductName(suggestedTags[0]);
      }
    } catch (err) {
      console.error('Tagging error', err);
    } finally {
      setIsTagging(false);
    }
  };

  const handleGenerateBackground = async (theme: string) => {
    setSelectedTheme(theme);
    if (!originalImage) return;
    setIsGeneratingBG(true);
    try {
      const enhancedTheme = marketCloaking ? `${theme} with asymmetrical commercial lighting and unique depth of field` : theme;
      const newBg = await generateProductBackground(originalImage, enhancedTheme);
      if (newBg) {
        setGeneratedMasters(prev => [newBg, ...prev]);
        setBaseImage(newBg);
      }
    } catch (err) {
      alert("Background generation failure.");
    } finally {
      setIsGeneratingBG(false);
    }
  };

  const handleSelectTheme = (theme: string) => {
    setSelectedTheme(theme);
    setCustomPrompt('');
  };

  const handleGenerate = async () => {
    if (!baseImage || !productName) return;
    const count = Math.min(50, Math.max(1, Math.floor(variantCount || 1)));
    setVariantCount(count);
    setIsGenerating(true);
    setProgress(0);
    const newVariants: ImageVariant[] = [];
    const activeTheme = customPrompt || selectedTheme || 'Studio White';
    try {
      const img = await loadImage(baseImage);
      const batchId = Date.now();
      for (let i = 0; i < count; i++) {
        const variant = await generateVariant(img, productName, `variant-${batchId}-${i + 1}`, {
          batchNumber,
          showDate,
          textureIntensity,
          opacity, 
          exportFormat,
          upscaleFactor,
          tags,
          marketCloaking,
          theme: activeTheme
        });
        newVariants.push(variant);
        setProgress(((i + 1) / count) * 100);
        // Added 5 second delay between requests to prevent hitting Vertex AI rate limits (429 errors)
        await new Promise(r => setTimeout(r, 5000));
      }
      
      // Sort all rates lowest -> highest
      newVariants.sort((a, b) => {
        if (a.status === 'failed') return 1;
        if (b.status === 'failed') return -1;
        return (a.detectedShipping || 0) - (b.detectedShipping || 0);
      });
      
      onVariantsGenerated(newVariants, autoNavigate);
    } catch (error) {
      console.error('Generation failed', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const downloadBatchSequentially = async () => {
    if (lastBatch.length === 0 || isBatchDownloading) return;
    setIsBatchDownloading(true);
    try {
      for (let i = 0; i < lastBatch.length; i++) {
        const v = lastBatch[i];
        const shortId = v.id.split('-').pop();
        const ext = v.config.exportFormat === 'image/png' ? 'png' : 'jpg';
        setExportProgress(((i + 1) / lastBatch.length) * 100);
        await downloadImage(v.dataUrl, `cloaked-asset-${shortId}.${ext}`);
        await new Promise(r => setTimeout(r, 600)); 
      }
      if (clearAfterDownload) {
        setLastBatch([]);
        await onClearHistory();
      }
    } finally {
      setIsBatchDownloading(false);
      setExportProgress(0);
    }
  };

  const handleClear = async () => {
    if (confirm("Reset current workspace?")) {
      setLastBatch([]);
      setBaseImage(null);
      setOriginalImage(null);
      setGeneratedMasters([]);
      setProductName('');
      await onClearHistory();
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="bg-white rounded-3xl shadow-xl border border-gray-100 p-8">
        <div className="flex justify-between items-start mb-8">
          <div>
            <h2 className="text-3xl font-black text-gray-900 tracking-tight flex items-center">
              <span className="mr-3">🎨</span> Synthesizer Core
              {marketCloaking && (
                <span className="ml-4 px-3 py-1 bg-green-500 text-white text-[10px] font-black uppercase rounded-full animate-pulse">
                  Market Cloaking Active
                </span>
              )}
            </h2>
            <p className="text-gray-400 text-xs font-bold uppercase mt-2 tracking-widest">Adversarial Asset Generation Engine</p>
          </div>
          <div className="flex items-center space-x-2 bg-gray-50 p-2 rounded-2xl border">
             <div className="flex items-center space-x-2 mr-4">
                <span className="text-[10px] font-black text-gray-500 uppercase">Anti-Detection</span>
                <button 
                  onClick={() => setMarketCloaking(!marketCloaking)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${marketCloaking ? 'bg-green-500' : 'bg-gray-200'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${marketCloaking ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
             </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
          <div className="space-y-8">
            <div className="space-y-3">
              <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest">Base Asset (Raw Product)</label>
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-gray-200 rounded-3xl aspect-[4/3] flex flex-col items-center justify-center cursor-pointer hover:border-pink-500 hover:bg-pink-50 transition-all overflow-hidden relative group"
              >
                {baseImage ? (
                  <img src={baseImage} className="w-full h-full object-contain" alt="Base" />
                ) : (
                  <div className="text-center">
                    <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
                      <span className="text-3xl">📥</span>
                    </div>
                    <p className="text-sm font-black text-gray-400 uppercase">Upload Original Product</p>
                  </div>
                )}
                <input type="file" ref={fileInputRef} onChange={handleImageUpload} className="hidden" accept="image/*" />
              </div>
            </div>

            <div className="p-6 bg-gradient-to-br from-gray-50 to-gray-100 rounded-3xl border border-gray-200">
               <h3 className="text-xs font-black text-gray-800 uppercase mb-4 flex justify-between">
                 <span>AI Background Env</span>
                 {isGeneratingBG && <span className="animate-spin text-lg">⏳</span>}
               </h3>
               <div className="grid grid-cols-3 gap-3 mb-6">
                  {BG_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => handleSelectTheme(preset.name)}
                      className={`flex flex-col items-center p-3 rounded-2xl border shadow-sm hover:border-pink-500 hover:shadow-md transition-all active:scale-95 ${
                        selectedTheme === preset.name && !customPrompt ? 'border-pink-500 bg-pink-50 text-pink-700' : 'bg-white text-gray-600'
                      }`}
                    >
                      <span className="text-xl">{preset.icon}</span>
                      <span className={`text-[9px] font-black mt-2 uppercase ${selectedTheme === preset.name && !customPrompt ? 'text-pink-600' : 'text-gray-600'}`}>{preset.name}</span>
                    </button>
                  ))}
               </div>
               <div className="space-y-2">
                 <p className="text-[9px] font-black text-gray-400 uppercase">Custom Prompt Override</p>
                 <div className="flex space-x-2">
                    <input 
                      type="text" 
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder="e.g. Modern kitchen with soft bokeh"
                      className="flex-1 px-4 py-3 text-xs rounded-xl border border-gray-200 shadow-inner bg-white focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-all outline-none text-gray-900"
                    />
                 </div>
               </div>
            </div>
            
            <div className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest">Product Title (SEO)</label>
                  <input type="text" value={productName} onChange={(e) => setProductName(e.target.value)} className="w-full px-5 py-4 rounded-2xl border-2 border-gray-100 focus:border-pink-500 outline-none font-bold text-gray-900 bg-white" />
                </div>
                <div className="space-y-2">
                  <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest">Variant Count</label>
                  <input type="number" value={variantCount} onChange={(e) => setVariantCount(Number(e.target.value))} className="w-full px-5 py-4 rounded-2xl border-2 border-gray-100 outline-none font-bold text-gray-900 bg-white" />
                </div>
              </div>
              
              <button
                onClick={handleGenerate}
                disabled={isGenerating || !baseImage || !productName}
                className={`w-full py-5 rounded-3xl font-black text-white shadow-2xl transition-all active:scale-[0.97] text-lg uppercase tracking-tighter ${
                  isGenerating || !baseImage || !productName ? 'bg-gray-300' : 'bg-gradient-to-r from-pink-500 to-purple-600 hover:brightness-110'
                }`}
              >
                {isGenerating ? `Generating ${variantCount} Images... ${Math.round(progress)}%` : `Generate ${variantCount} Images`}
              </button>
            </div>
          </div>

          <div className="flex flex-col h-full bg-[#0a0a0a] rounded-3xl p-8 border border-gray-800 shadow-inner">
             {isGenerating && (
               <div className="flex justify-between items-center mb-6">
                  <h3 className="text-sm font-black text-white uppercase tracking-widest">
                    Generating images
                  </h3>
                  <span className="border text-[10px] px-3 py-1 rounded-full font-black animate-pulse border-cyan-400 bg-cyan-900/30 text-cyan-400">
                    {Math.round(progress)}%
                  </span>
               </div>
             )}

             {!isGenerating && lastBatch.length > 0 && (() => {
               const lowestRate = lastBatch[0]?.detectedShipping || 0;
               return (
                 <div className="mb-6 p-6 rounded-2xl border border-gray-800 bg-[#1a1a24]">
                   <div className="flex items-center text-[#10b981] text-[10px] font-black uppercase tracking-widest mb-3">
                     <span className="w-1.5 h-1.5 rounded-full bg-[#10b981] mr-2"></span>
                     Analysis Complete
                   </div>
                   <h3 className="text-xl font-bold text-white mb-1">
                     {lastBatch.length} shipping rates found
                   </h3>
                   <p className="text-gray-400 text-xs">
                     Rates sorted from lowest to highest. <span className="text-[#a855f7] font-bold">Cheapest: ₹{lowestRate}</span>
                   </p>
                 </div>
               );
             })()}

             <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-4">
                {isGenerating ? (
                  <div className="flex h-full min-h-96 flex-col items-center justify-center px-8 text-center">
                    <div className="relative mb-7 flex h-24 w-24 items-center justify-center">
                      <div className="absolute inset-0 rounded-full border-4 border-gray-200" />
                      <div className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-cyan-500 border-r-purple-500" />
                      <span className="text-lg font-black text-gray-900">
                        {Math.round(progress)}%
                      </span>
                    </div>

                    <h4 className="text-lg font-black uppercase tracking-wide text-gray-900">
                      Generating your images
                    </h4>
                    <p className="mt-2 max-w-xs text-xs font-medium leading-5 text-gray-500">
                      Creating variant {Math.min(variantCount, Math.floor((progress / 100) * variantCount) + 1)} of {variantCount}. Please keep this page open.
                    </p>

                    <div className="mt-7 h-2 w-full max-w-sm overflow-hidden rounded-full bg-gray-200">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-purple-600 transition-[width] duration-500"
                        style={{ width: `${Math.max(3, progress)}%` }}
                      />
                    </div>

                    <div className="mt-4 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-cyan-600">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-500" />
                      AI generation in progress
                    </div>
                  </div>
                ) : lastBatch.length > 0 ? (
                  <div className="grid grid-cols-2 gap-6">
                    {lastBatch.map((v, index) => {
                      const isLowest = index === 0;
                      return (
                      <div 
                        key={v.id} 
                        onClick={() => setSelectedVariantId(v.id)}
                        className={`bg-[#12121a] rounded-2xl border flex flex-col group relative overflow-hidden transition-all cursor-pointer ${
                          isLowest ? 'border-[#a855f7] shadow-[0_0_15px_rgba(168,85,247,0.15)]' : 'border-gray-800 hover:border-gray-700'
                        }`}
                      >
                        {v.status === 'failed' ? (
                          <div className="w-full aspect-square bg-gray-900 flex flex-col items-center justify-center p-4 text-center">
                            <span className="text-2xl mb-2">⚠️</span>
                            <span className="text-[10px] font-black text-red-500 uppercase">{v.errorMessage || 'Image not generated'}</span>
                          </div>
                        ) : (
                          <>
                            <div className="w-full aspect-square bg-gray-900 relative">
                              {isLowest && (
                                <div className="absolute top-0 left-0 z-10 bg-[#a855f7] text-white text-[10px] font-black px-3 py-1.5 rounded-br-xl uppercase tracking-wider flex items-center shadow-md">
                                  <span className="mr-1">★</span> Lowest
                                </div>
                              )}
                              <img src={v.dataUrl} className="w-full h-full object-cover" alt="V" />
                            </div>
                            
                            <div className="mt-2 flex flex-col space-y-2 p-4 pt-2">
                              <div className="flex justify-between items-start">
                                <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest leading-tight w-16">Shipping Rate</span>
                                <span className="bg-[#1a1a24] text-gray-400 text-[9px] px-2 py-1 rounded-full font-bold whitespace-nowrap truncate max-w-[90px] text-center border border-gray-800">{productName || 'Product'}</span>
                              </div>
                              
                              <div className="flex items-baseline space-x-1 pb-2">
                                <span className="text-3xl font-black text-white tracking-tighter">₹{v.detectedShipping ?? 102}</span>
                                <span className="text-[10px] font-medium text-gray-500">/ shipment</span>
                              </div>
                              
                              <div className="pt-2 border-t border-gray-800/50">
                                 <button 
                                   onClick={(e) => { e.stopPropagation(); downloadImage(v.dataUrl, `v-${v.id.slice(-4)}.jpg`); }} 
                                   className="w-full py-2.5 rounded-xl border border-gray-700 bg-[#1a1a24] text-gray-300 text-[10px] font-bold hover:bg-gray-700 hover:text-white transition-colors flex items-center justify-center space-x-2"
                                 >
                                   <span>↓</span>
                                   <span>Download Image</span>
                                 </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )})}
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center opacity-30 text-gray-500">
                    <span className="text-6xl mb-4">🎭</span>
                    <p className="font-black uppercase text-xs tracking-widest">Buffer Empty</p>
                  </div>
                )}
             </div>

             {!isGenerating && lastBatch.length > 0 && (
               <div className="mt-6 p-6 bg-white rounded-3xl border border-gray-200 shadow-lg space-y-4">
                  <button 
                    onClick={downloadBatchSequentially}
                    disabled={isBatchDownloading}
                    className="w-full py-4 bg-gray-900 text-white rounded-2xl text-xs font-black uppercase shadow-md hover:bg-black transition-all"
                  >
                    {isBatchDownloading ? `Exporting... ${Math.round(exportProgress)}%` : 'Bulk Export Cloaked Batch'}
                  </button>
                  <div className="flex items-center space-x-3 p-4 bg-red-50 rounded-2xl border border-red-100">
                     <input type="checkbox" checked={clearAfterDownload} onChange={(e) => setClearAfterDownload(e.target.checked)} className="w-4 h-4 accent-red-600" />
                     <label className="text-[10px] font-black text-red-700 uppercase tracking-tighter">Destroy History after download</label>
                  </div>
               </div>
             )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SynthesizerModule;
