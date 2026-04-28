import { clsx } from "@/lib/utils";
import type { CSSProperties } from "react";

export default function Card({ children, className, style }: {
  children: React.ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={clsx(
        "dark:bg-dark-card dark:border-dark-border bg-white border-light-border",
        "border rounded-xl p-5",
        className
      )}
      style={style}
    >
      {children}
    </div>
  );
}
