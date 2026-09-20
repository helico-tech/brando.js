import type { View, Overview, Row } from './types.js';
import { fmt, num, short, Status } from './lib/presentation.js';
import { Sidebar } from './components/sidebar.js';
import { Records } from './components/records.js';
import { OverviewPanels } from './components/overview-panels.js';
import { SubmitDialog } from './components/submit-dialog.js';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  CircleHelp,
  Code2,
  Loader2,
  Menu,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
} from 'lucide-react';

import { Button } from './components/ui/button.js';
import { Badge } from './components/ui/badge.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js';
import '@fontsource-variable/inter';
import './styles.css';

function App() {
  const [view, setView] = useState<View>('Overview');
  const [overview, setOverview] = useState<Overview>();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [permission, setPermission] = useState('read');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [updated, setUpdated] = useState<Date>();
  const [mobile, setMobile] = useState(false);
  const [detail, setDetail] = useState<{ title: string; data: Row; invocationId?: string }>();
  const [submitOpen, setSubmitOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const api = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(`/api/brando${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await response.json()) as { error?: string };
      if (response.status === 401) setAuthRequired(true);
      if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
      return data as T;
    },
    [token],
  );
  const refresh = () => setRevision((r) => r + 1);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const endpoint =
          view === 'Actors' ? '/actors' : view === 'Reminders' ? '/reminders' : '/invocations';
        const params = new URLSearchParams({
          limit: view === 'Overview' ? '6' : '20',
          offset: String(offset),
          ...(search ? { search } : {}),
          ...(status && view === 'Invocations' ? { status } : {}),
        });
        const [next, list, session] = await Promise.all([
          api<Overview>('/overview'),
          api<Row[]>(`${endpoint}?${params}`),
          api<{ permission: string }>('/session'),
        ]);
        if (active) {
          setOverview(next);
          setRows(list);
          setPermission(session.permission);
          setError('');
          setAuthRequired(false);
          setUpdated(new Date());
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Connection failed');
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [view, api, search, status, offset, revision]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  function navigate(next: View) {
    setView(next);
    setSearch('');
    setStatus('');
    setOffset(0);
    setMobile(false);
  }
  async function inspect(row: Row, actor = false) {
    try {
      const data = actor
        ? await api<Row>(
            `/actor?${new URLSearchParams({ type: String(row.actor_type), id: JSON.stringify(row.actor_id) })}`,
          )
        : await api<Row>(`/invocations/${encodeURIComponent(String(row.invocation_id))}`);
      setDetail({
        title: actor ? `${row.actor_type} / ${fmt(row.actor_id)}` : 'Invocation details',
        data,
        invocationId: actor ? undefined : String(row.invocation_id),
      });
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  async function resubmit() {
    if (!detail?.invocationId) return;
    setBusy(true);
    try {
      const result = await api<{ invocationId: string }>('/resubmit', { id: detail.invocationId });
      setToast(`New invocation accepted: ${result.invocationId}`);
      setDetail(undefined);
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const ready = !!overview?.health.ready && !error;
  return (
    <div className="app-shell">
      {mobile && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <Sidebar view={view} mobile={mobile} overview={overview} navigate={navigate} />
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-toggle"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{view}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment">
              <span /> {overview?.health.name ?? 'Connecting'}
            </span>
            <a
              href="https://github.com/helico-tech/brando.js#quick-start"
              aria-label="Documentation"
              target="_blank"
              rel="noreferrer"
            >
              <CircleHelp size={18} />
            </a>
            <div className="topbar-avatar">B</div>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR DURABLE RUNTIME</div>
              <h1>{view === 'Overview' ? 'Overview' : view}</h1>
              <p>
                {
                  {
                    Overview: 'A little peace of mind for everything running in the background.',
                    Actors: 'Inspect the state and history of every virtual actor.',
                    Invocations: 'Follow each message from durable acceptance to its outcome.',
                    Reminders: 'Scheduled self-messages, waiting for their moment.',
                    Catalogue: 'The actor types and message contracts registered on this replica.',
                    Runtime: 'Connection health and the work happening on this replica.',
                  }[view]
                }
              </p>
            </div>
            <div className="heading-actions">
              <Button variant="outline" size="sm" onClick={refresh} aria-label="Refresh data">
                <RefreshCw size={15} />
                Refresh
              </Button>
              {permission === 'write' && (
                <Button size="sm" onClick={() => setSubmitOpen(true)}>
                  <Plus size={16} />
                  Send message
                </Button>
              )}
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <span>
                {error}.{' '}
                {authRequired
                  ? 'Enter your access token to connect.'
                  : 'Showing the last successful snapshot. Retrying automatically.'}
              </span>
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry
              </Button>
            </div>
          )}
          {authRequired && (
            <form
              className="auth-panel"
              onSubmit={(event) => {
                event.preventDefault();
                setToken(tokenDraft);
              }}
            >
              <label htmlFor="token">Console access token</label>
              <Input
                id="token"
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder="Bearer token"
              />
              <Button type="submit">Connect</Button>
            </form>
          )}
          {!overview && !error ? (
            <div className="loading">
              <Loader2 className="spin" />
              Connecting to your runtime…
            </div>
          ) : (
            overview && (
              <>
                {view === 'Overview' && (
                  <OverviewPanels overview={overview} ready={ready} navigate={navigate} />
                )}
                {(view === 'Overview' ||
                  view === 'Invocations' ||
                  view === 'Actors' ||
                  view === 'Reminders') && (
                  <Records
                    view={view}
                    rows={rows}
                    search={search}
                    status={status}
                    offset={offset}
                    navigate={navigate}
                    inspect={inspect}
                    setSearch={setSearch}
                    setStatus={setStatus}
                    setOffset={setOffset}
                  />
                )}
                {view === 'Catalogue' && (
                  <div className="catalogue-grid">
                    {overview.catalogue.map((actor) => (
                      <Card className="catalogue-card" key={actor.name}>
                        <div className="catalogue-title">
                          <span className="catalogue-icon">
                            <Boxes size={22} />
                          </span>
                          <h2>{actor.name}</h2>
                          <Badge variant="outline">{actor.messages.length} messages</Badge>
                        </div>
                        <p className="muted small">
                          State <code>{actor.stateType}</code> · ID <code>{actor.idType}</code>
                        </p>
                        <div className="contract-list">
                          {actor.messages.map((msg) => (
                            <button
                              key={msg.name}
                              onClick={() => setDetail({ title: msg.name, data: msg })}
                            >
                              <Code2 size={15} />
                              <span>{short(msg.name)}</span>
                              <span className="mono muted">
                                {msg.resultType === 'brando.unit.v1' ? 'void' : msg.resultType}
                              </span>
                              <ChevronRight size={13} />
                            </button>
                          ))}
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
                {view === 'Runtime' && (
                  <div className="runtime-detail-grid">
                    <Card className="runtime-detail">
                      <h2>
                        <Server size={18} />
                        Replica
                      </h2>
                      <dl>
                        <dt>Application</dt>
                        <dd>{overview.health.name}</dd>
                        <dt>Owner</dt>
                        <dd className="mono break-all">{overview.health.owner}</dd>
                        <dt>Uptime</dt>
                        <dd>{Math.floor(overview.health.uptimeMs / 60000)} minutes</dd>
                        <dt>Readiness</dt>
                        <dd>
                          <Status status={overview.health.ready ? 'READY' : 'OFFLINE'} />
                        </dd>
                        <dt>Last runtime error</dt>
                        <dd>{overview.health.lastError ?? 'None recorded'}</dd>
                      </dl>
                    </Card>
                    <Card className="runtime-detail">
                      <h2>
                        <Activity size={18} />
                        Since this replica started
                      </h2>
                      <dl>
                        {Object.entries(overview.health.metrics).map(([key, value]) => (
                          <React.Fragment key={key}>
                            <dt>{key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)}</dt>
                            <dd className="mono">{num(value)}</dd>
                          </React.Fragment>
                        ))}
                      </dl>
                    </Card>
                  </div>
                )}
                {view === 'Overview' && (
                  <div className="bottom-note">
                    <span>
                      <ShieldCheck size={15} />
                      State, results, and managed effects. Committed together.
                    </span>
                    <a
                      href="https://github.com/helico-tech/brando.js/blob/HEAD/docs/domain/semantics.md"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Understand the guarantees
                      <ArrowUpRight size={13} />
                    </a>
                  </div>
                )}
                <footer className="page-footer">
                  <span>
                    <span className={`live-dot ${ready ? '' : 'offline'}`} />
                    {ready ? 'Connected to your runtime' : 'Connection needs attention'}
                  </span>
                  <span>
                    Last synced {updated?.toLocaleTimeString()}{' '}
                    <span className="footer-separator">/</span> brando.js
                  </span>
                </footer>
              </>
            )
          )}
        </main>
      </div>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined);
        }}
      >
        <DialogContent className="detail-dialog">
          <DialogHeader>
            <DialogTitle>{detail?.title}</DialogTitle>
            <DialogDescription>
              Durable data from your application’s PostgreSQL store.
            </DialogDescription>
          </DialogHeader>
          <pre className="json-view">{JSON.stringify(detail?.data, null, 2)}</pre>
          {detail?.invocationId && (
            <div className="dialog-actions">
              <Button
                variant="outline"
                onClick={() => {
                  void inspect({ invocation_id: detail.invocationId });
                }}
              >
                <RefreshCw size={14} />
                Refresh
              </Button>
              {permission === 'write' &&
                ['COMPLETED', 'FAILED'].includes(String(detail.data.status)) && (
                  <Button
                    onClick={() => {
                      void resubmit();
                    }}
                    disabled={busy}
                  >
                    Resubmit as new invocation
                    <ArrowRight size={14} />
                  </Button>
                )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <SubmitDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        catalogue={overview?.catalogue ?? []}
        api={api}
        onSuccess={(id) => {
          setToast(`Durably accepted: ${id}`);
          refresh();
        }}
      />
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={17} />
            {toast}
          </span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
