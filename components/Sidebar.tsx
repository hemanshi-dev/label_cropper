"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed left-0 top-0 z-20 flex h-full w-64 flex-col gap-4 overflow-hidden border-r border-cyan-300 bg-white p-4 transition-colors dark:border-neutral-800 dark:bg-black">
      <Link
        href="/"
        className={`px-4 py-3 rounded-lg border-2 transition-all font-semibold ${
          pathname === "/"
            ? "border-cyan-300 text-cyan-600 bg-cyan-50 shadow-sm dark:border-cyan-700 dark:bg-neutral-950 dark:text-cyan-300"
            : "border-transparent text-gray-600 hover:bg-gray-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
        }`}
      >
        Label Cropper
      </Link>
      
      <Link
        href="/synthesizer"
        className={`px-4 py-3 rounded-lg border-2 transition-all font-semibold ${
          pathname === "/synthesizer"
            ? "border-cyan-300 text-cyan-600 bg-cyan-50 shadow-sm dark:border-cyan-700 dark:bg-neutral-950 dark:text-cyan-300"
            : "border-transparent text-gray-600 hover:bg-gray-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
        }`}
      >
        Generate Image
      </Link>

      <ThemeToggle />
    </aside>
  );
}
