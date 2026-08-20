export function StatCard({ label, value, onClick }: { label: string; value: string | number; onClick?: () => void }) {
  return (
    <div
      className={`stat-card${onClick ? " clickable" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}
    >
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
