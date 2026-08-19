export function Funnel({ stages }: { stages: Array<{ stage: string; label: string; actorCount: number }> }) {
  const max = Math.max(1, ...stages.map((s) => s.actorCount));
  return (
    <div>
      {stages.map((s, i) => {
        const pctOfMax = (s.actorCount / max) * 100;
        const pctOfPrev = i === 0 ? 100 : stages[i - 1]!.actorCount > 0 ? Math.round((s.actorCount / stages[i - 1]!.actorCount) * 100) : 0;
        return (
          <div key={s.stage} style={{ marginBottom: ".6rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: ".8rem", marginBottom: ".2rem" }}>
              <span>{s.label}</span>
              <span className="muted">
                {s.actorCount} actor{s.actorCount === 1 ? "" : "s"}
                {i > 0 && <span> ({pctOfPrev}% of previous stage)</span>}
              </span>
            </div>
            <div className="bar-track" style={{ height: "18px" }}>
              <div className="bar-fill" style={{ width: `${pctOfMax}%`, height: "100%" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
