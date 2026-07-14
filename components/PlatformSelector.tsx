"use client";

import { PLATFORMS, type PlatformID, type CropTemplate } from "@/lib/platforms";

interface PlatformSelectorProps {
  selected: PlatformID | null;
  onSelect: (id: PlatformID) => void;
}

export default function PlatformSelector({
  selected,
  onSelect,
}: PlatformSelectorProps) {
  return (
    <div className="max-w-md mx-auto mb-6">
      <p className="mb-3 text-center text-sm font-medium text-gray-700 dark:text-neutral-300">
        Select platform
      </p>
      <div className="grid grid-cols-3 gap-3">
        {PLATFORMS.map((p) => (
          <PlatformCard
            key={p.id}
            platform={p}
            isActive={selected === p.id}
            onClick={() => onSelect(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function PlatformCard({
  platform,
  isActive,
  onClick,
}: {
  platform: CropTemplate;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all cursor-pointer ${
        isActive
          ? `${platform.borderActive} bg-white shadow-md dark:bg-neutral-950`
          : "border-gray-200 bg-white hover:border-gray-400 hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-600"
      }`}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full overflow-hidden shadow-sm border border-gray-100 dark:border-neutral-800 bg-white"
      >
        <img 
          src={platform.logo} 
          alt={`${platform.name} logo`} 
          className="h-full w-full object-contain"
        />
      </div>
      <span
        className={`text-sm font-semibold ${
          isActive ? platform.textActive : "text-gray-700 dark:text-neutral-200"
        }`}
      >
        {platform.name}
      </span>
      {isActive && (
        <div
          className={`absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full ${platform.color} flex items-center justify-center`}
        >
          <svg
            className="h-3 w-3 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
      )}
    </button>
  );
}
