"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

function getCurrentTheme(): Theme {
  return document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(
    (onThemeChange) => {
      window.addEventListener("themechange", onThemeChange);
      return () => window.removeEventListener("themechange", onThemeChange);
    },
    getCurrentTheme,
    () => "light",
  );

  const toggleTheme = () => {
    const nextTheme: Theme = theme === "dark" ? "light" : "dark";

    document.documentElement.classList.toggle(
      "dark",
      nextTheme === "dark",
    );
    document.documentElement.style.colorScheme = nextTheme;
    window.localStorage.setItem("theme", nextTheme);
    window.dispatchEvent(new Event("themechange"));
  };

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="mt-auto grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_36px] items-center gap-3 overflow-hidden rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-left text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-900"
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      title={`Switch to ${isDark ? "light" : "dark"} theme`}
      aria-pressed={isDark}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        {isDark ? (
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
          </svg>
        ) : (
          <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path strokeLinecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
          </svg>
        )}
        <span className="truncate">{isDark ? "Dark theme" : "Light theme"}</span>
      </span>

      <span
        className={`relative block h-5 w-9 shrink-0 overflow-hidden rounded-full transition-colors ${
          isDark ? "bg-indigo-500" : "bg-gray-300"
        }`}
        aria-hidden="true"
      >
        <span
          className={`absolute left-0.5 top-0.5 block h-4 w-4 rounded-full shadow-sm transition-transform ${
            isDark ? "translate-x-4" : "translate-x-0"
          }`}
          style={{ backgroundColor: "#ffffff" }}
        />
      </span>
    </button>
  );
}
