import { nivelColor } from "@/lib/utils";
import { useTheme } from "@/context/ThemeContext";

export default function SupplyBar({ label, val }: { label: string; val: number | null }) {
  const pct = val === null ? 0 : Math.min(Math.max(val, 0), 100);
  const txt = val === null ? "N/A" : `${val.toFixed(0)}%`;
  const { theme } = useTheme();
  const color = nivelColor(val, theme);

  return (
    <div className="mb-3">
      <div className="flex justify-between mb-1">
        <span className="text-[12px] font-medium dark:text-dark-text text-light-text">{label}</span>
        <span className="text-[12px] font-bold" style={{ color }}>{txt}</span>
      </div>
      <div className="w-full h-[5px] dark:bg-dark-border2 bg-light-border2 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
