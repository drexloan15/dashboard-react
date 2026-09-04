"use client";

import { useId } from "react";

interface Props {
  children: React.ReactNode;
  content: string;
  className?: string;
  label?: string;
}

export default function AccessibleTooltip({ children, content, className = "", label }: Props) {
  const tooltipId = useId();

  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={tooltipId}
        className={`${className} focus:outline-none focus:ring-2 focus:ring-brand-blue/50 focus:ring-offset-1 dark:focus:ring-offset-dark-card`}
      >
        {children}
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-72
          -translate-x-1/2 rounded-md bg-gray-900 px-2.5 py-2 text-left text-[11px] font-normal
          normal-case leading-snug tracking-normal text-white opacity-0 shadow-lg transition-opacity
          group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}
