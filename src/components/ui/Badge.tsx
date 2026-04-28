export default function Badge({ children, bg }: { children: React.ReactNode; bg: string }) {
  return (
    <span
      className="text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide text-white"
      style={{ background: bg }}>
      {children}
    </span>
  );
}
