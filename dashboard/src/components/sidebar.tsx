import packageJson from '../../../package.json' with { type: 'json' };
import type { View, Overview } from '../types.js';
import { num } from '../lib/presentation.js';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  Boxes,
  ChevronDown,
  Clock3,
  Code2,
  ExternalLink,
  GitBranch,
  LayoutDashboard,
  MoreHorizontal,
  Server,
  ShieldCheck,
} from 'lucide-react';
const nav = [
  { name: 'Overview', icon: LayoutDashboard },
  { name: 'Actors', icon: Boxes },
  { name: 'Invocations', icon: ArrowDownLeft },
  { name: 'Reminders', icon: Clock3 },
  { name: 'Catalogue', icon: Code2 },
] as const;
export function Sidebar({
  view,
  mobile,
  overview,
  navigate,
}: {
  view: View;
  mobile: boolean;
  overview?: Overview;
  navigate: (view: View) => void;
}) {
  return (
    <aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
      <a
        className="brand"
        href="#"
        onClick={(event) => {
          event.preventDefault();
          navigate('Overview');
        }}
      >
        <span className="brand-mark">
          b<span>·</span>
        </span>
        <span>
          brando<span className="brand-js">.js</span>
        </span>
      </a>
      <div className="workspace">
        <span className="workspace-icon">
          <GitBranch size={16} />
        </span>
        <div>
          <strong>{overview?.health.name ?? 'Connecting'}</strong>
          <span>Actor application</span>
        </div>
        <ChevronDown size={14} />
      </div>
      <div className="nav-label">WORKSPACE</div>
      <nav>
        {nav.map(({ name, icon: Icon }) => (
          <button
            key={name}
            onClick={() => navigate(name)}
            className={view === name ? 'nav-item selected' : 'nav-item'}
          >
            <Icon size={18} />
            {name}
            {name === 'Actors' && <span className="nav-count">{num(overview?.actors?.total)}</span>}
            {name === 'Overview' && <span className="nav-selected-dot" />}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-note">
          <span className="note-icon">
            <ShieldCheck size={19} />
          </span>
          <strong>Built to keep going.</strong>
          <p>
            Durable actors. One database.
            <br />
            Every message accounted for.
          </p>
          <a
            href="https://github.com/helico-tech/brando.js#readme"
            target="_blank"
            rel="noreferrer"
          >
            Explore the docs <ArrowUpRight size={14} />
          </a>
        </div>
        <button
          className={`nav-item ${view === 'Runtime' ? 'selected' : ''}`}
          onClick={() => navigate('Runtime')}
        >
          <Server size={17} />
          Runtime
        </button>
        <a
          className="nav-item"
          href="https://github.com/helico-tech/brando.js"
          target="_blank"
          rel="noreferrer"
        >
          <BookOpen size={17} />
          Documentation
          <ExternalLink size={13} />
        </a>
        <div className="sidebar-footer">
          <span className="avatar">B</span>
          <div>
            <strong>Brando console</strong>
            <span>v{packageJson.version} · PostgreSQL</span>
          </div>
          <MoreHorizontal size={18} />
        </div>
      </div>
    </aside>
  );
}
