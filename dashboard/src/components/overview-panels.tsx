import type { Overview, View } from '../types.js';
import { num, Status } from '../lib/presentation.js';
import { Card } from './ui/card.js';
import { ActivityChart } from './activity-chart.js';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock3,
  Database,
  Fingerprint,
  Radio,
  Zap,
} from 'lucide-react';
export function OverviewPanels({
  overview,
  ready,
  navigate,
}: {
  overview: Overview;
  ready: boolean;
  navigate: (view: View) => void;
}) {
  const counts = Object.fromEntries(
    (overview?.counts ?? []).map((c) => [String(c.status), Number(c.count)]),
  );
  const completed = counts.COMPLETED ?? 0;
  const failed = counts.FAILED ?? 0;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <>
      <div className="health-strip">
        <div>
          <span className={`live-dot ${ready ? '' : 'offline'}`} />
          <strong>{ready ? 'All systems operational' : 'Runtime needs attention'}</strong>
          <span className="health-divider" />
          <span>PostgreSQL {overview.health.database ? 'connected' : 'unavailable'}</span>
        </div>
        <span className="live-label">
          <Radio size={13} /> Live updates
        </span>
      </div>
      <div className="stats-grid">
        {[
          {
            title: 'Total actors',
            value: overview.actors?.total,
            icon: Boxes,
            note: `${overview.catalogue.length} registered actor types`,
            label: 'Durable',
            variant: 'green',
          },
          {
            title: 'Invocations',
            value: total,
            icon: ArrowDownLeft,
            note: `${num(completed)} completed successfully`,
            label: 'Retained',
            variant: 'neutral',
          },
          {
            title: 'In the queue',
            value: (counts.PENDING ?? 0) + (counts.RUNNING ?? 0),
            icon: Activity,
            note: `${num(counts.RUNNING)} running · ${num(counts.PENDING)} pending`,
            label: 'Live',
            variant: 'green',
          },
          {
            title: 'Scheduled reminders',
            value: overview.reminders?.total,
            icon: Clock3,
            note: `${num(overview.reminders?.due)} due for delivery`,
            label: 'Waiting',
            variant: 'amber',
          },
        ].map(({ title, value, icon: Icon, note, label, variant }) => (
          <Card key={title} className="stat-card">
            <div className="stat-heading">
              <span>{title}</span>
              <Icon size={17} />
            </div>
            <div className="stat-value">
              {num(value)}
              <span className={`stat-tag ${variant}`}>{label}</span>
            </div>
            <div className="stat-note">{note}</div>
          </Card>
        ))}
      </div>
      <div className="middle-grid">
        <Card className="activity-card">
          <div className="panel-heading">
            <div>
              <h2>Invocation activity</h2>
              <p>Durable outcomes over the last hour</p>
            </div>
            <span className="time-window">
              <Clock3 size={13} />
              Last 60 minutes
            </span>
          </div>
          <ActivityChart activity={overview.activity} />
          <div className="chart-footer">
            <span>
              <i className="legend-success" />
              Completed
            </span>
            <span>
              <i className="legend-failed" />
              Failed
            </span>
            <span className="chart-caption">One bar per minute</span>
          </div>
        </Card>
        <Card className="runtime-card">
          <div className="panel-heading">
            <h2>Runtime health</h2>
            <span className="health-icon">
              <Activity size={17} />
            </span>
          </div>
          <div className="health-score">
            <strong>{ready ? 'Healthy' : 'Degraded'}</strong>
            <p>
              {ready ? 'Ready to process your messages' : 'Check connection and runtime details'}
            </p>
          </div>
          <div className="health-row">
            <span>
              <Database size={14} />
              Database
            </span>
            <Status status={overview.health.database ? 'CONNECTED' : 'OFFLINE'} />
          </div>
          <div className="health-row">
            <span>
              <Zap size={14} />
              Active leases
            </span>
            <strong>{num(overview.actors?.leased)}</strong>
          </div>
          <div className="health-row">
            <span>
              <CheckCircle2 size={14} />
              Success rate
            </span>
            <strong>
              {completed + failed
                ? `${((completed / (completed + failed)) * 100).toFixed(1)}%`
                : '—'}
            </strong>
          </div>
          <div className="health-row">
            <span>
              <Fingerprint size={14} />
              Incompatible actors
            </span>
            <strong>{overview.health.incompatibleActors}</strong>
          </div>
          <button className="text-link runtime-link" onClick={() => navigate('Runtime')}>
            View runtime details <ArrowRight size={14} />
          </button>
        </Card>
      </div>
    </>
  );
}
