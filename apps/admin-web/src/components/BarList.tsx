export function BarList({ items }: { items: Array<{ label: string; count: number }> }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <p className="muted">No data in this range.</p>;
  return (
    <div>
      {items.map((item) => (
        <div className="bar-row" key={item.label}>
          <span className="bar-label" title={item.label}>
            {item.label}
          </span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(item.count / max) * 100}%` }} />
          </span>
          <span className="bar-count">{item.count}</span>
        </div>
      ))}
    </div>
  );
}
