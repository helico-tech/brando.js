import type { Row } from '../types.js';
import { time } from '../lib/presentation.js';
export function ActivityChart({ activity }: { activity: Row[] }) {
  const now = Math.floor(Date.now() / 60000) * 60000;
  const data = Array.from({ length: 60 }, (_, i) => {
    const t = now - (59 - i) * 60000;
    const row = activity.find((r) => new Date(String(r.time)).getTime() === t);
    return { time: t, completed: Number(row?.completed ?? 0), failed: Number(row?.failed ?? 0) };
  });
  const max = Math.max(4, ...data.map((r) => r.completed + r.failed));
  return (
    <div
      className="chart"
      role="img"
      aria-label={`Completed and failed invocations over the past hour. ${data.reduce((n, r) => n + r.completed + r.failed, 0)} total outcomes.`}
    >
      <div className="chart-y">
        {[max, Math.round(max / 2), 0].map((n) => (
          <span key={n}>{n}</span>
        ))}
      </div>
      <div className="chart-plot">
        <div className="chart-gridline top" />
        <div className="chart-gridline middle" />
        <div className="chart-gridline bottom" />
        <div className="chart-bars">
          {data.map((r, i) => (
            <div
              key={i}
              className="chart-bar-column"
              title={`${time(r.time)}: ${r.completed} completed, ${r.failed} failed`}
            >
              <div
                className="chart-bar failed-bar"
                style={{ height: `${(r.failed / max) * 100}%` }}
              />
              <div
                className="chart-bar completed-bar"
                style={{ height: `${(r.completed / max) * 100}%` }}
              />
            </div>
          ))}
        </div>
        <div className="chart-x">
          {[59, 45, 30, 15, 0].map((n) => (
            <span key={n}>
              {new Date(now - n * 60000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
