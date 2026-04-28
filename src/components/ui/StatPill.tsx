interface Props {
  value: string | number;
  label: string;
  color: string;
  sub?: string;
}

export default function StatPill({ value, label, color, sub }: Props) {
  return (
    <div className="text-center px-3 py-3">
      <div className="text-5xl font-extrabold leading-none mb-2" style={{ color }}>{value}</div>
      <div className="text-[11px] uppercase tracking-widest font-semibold dark:text-dark-text text-light-text mt-1">
        {label}
      </div>
      {sub && <div className="text-[10px] dark:text-dark-muted text-light-muted mt-0.5">{sub}</div>}
    </div>
  );
}
