import type { Dispatch, SetStateAction } from 'react';
import type { Row, View } from '../types.js';
import { fmt, num, time, short, Status, Empty } from '../lib/presentation.js';
import { Card } from './ui/card.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Table, TableHeader, TableBody, TableCell, TableHead, TableRow } from './ui/table.js';
import {
  ArrowDownLeft,
  ArrowRight,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Search,
} from 'lucide-react';
export function Records({
  view,
  rows,
  search,
  status,
  offset,
  navigate,
  inspect,
  setSearch,
  setStatus,
  setOffset,
}: {
  view: View;
  rows: Row[];
  search: string;
  status: string;
  offset: number;
  navigate: (view: View) => void;
  inspect: (row: Row, actor?: boolean) => Promise<void>;
  setSearch: (search: string) => void;
  setStatus: (status: string) => void;
  setOffset: Dispatch<SetStateAction<number>>;
}) {
  return (
    <Card className="records-card">
      <div className="panel-heading">
        <div className="panel-title">
          <h2>
            {view === 'Overview'
              ? 'Recent invocations'
              : view === 'Actors'
                ? 'Actor instances'
                : view === 'Reminders'
                  ? 'Pending reminders'
                  : 'Invocation history'}
          </h2>
          <span className="count-chip">{rows.length}</span>
        </div>
        {view === 'Overview' ? (
          <button className="text-link" onClick={() => navigate('Invocations')}>
            View all invocations <ArrowRight size={14} />
          </button>
        ) : (
          <div className="table-tools">
            {view !== 'Reminders' && (
              <div className="search-field">
                <Search size={15} />
                <Input
                  aria-label={view === 'Actors' ? 'Search actors' : 'Search invocations'}
                  value={search}
                  placeholder={view === 'Actors' ? 'Search actor ID…' : 'Search invocation ID…'}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                />
              </div>
            )}
            {view === 'Invocations' && (
              <select
                aria-label="Status filter"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">All statuses</option>
                {['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty
          text={
            search || status
              ? 'No matching records'
              : view === 'Reminders'
                ? 'Nothing scheduled'
                : 'No records yet'
          }
          description={
            search || status
              ? 'Try a different search or status filter.'
              : view === 'Reminders'
                ? 'Named reminders appear here until they enter the mailbox.'
                : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {(view === 'Actors'
                ? ['Actor', 'Type', 'Revision', 'Mailbox', 'Updated', '']
                : view === 'Reminders'
                  ? ['Reminder', 'Actor', 'Message', 'Due at', '']
                  : ['Invocation', 'Actor', 'Message', 'Status', 'Accepted', '']
              ).map((h, i) => (
                <TableHead key={`${h}${i}`}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow
                key={String(
                  row.invocation_id ?? `${row.actor_type}:${row.actor_key}:${row.name ?? i}`,
                )}
              >
                {view === 'Actors' ? (
                  <>
                    <TableCell>
                      <button
                        className="actor-button"
                        onClick={() => {
                          void inspect(row, true);
                        }}
                      >
                        <span className="table-icon">
                          <Boxes size={15} />
                        </span>
                        {fmt(row.actor_id)}
                      </button>
                    </TableCell>
                    <TableCell>
                      <span className="type-pill">{String(row.actor_type)}</span>
                    </TableCell>
                    <TableCell className="mono">{String(row.revision)}</TableCell>
                    <TableCell>{num(row.pending)} pending</TableCell>
                    <TableCell className="muted mono">{time(row.updated_at)}</TableCell>
                  </>
                ) : view === 'Reminders' ? (
                  <>
                    <TableCell>
                      <span className="cell-title">
                        <Clock3 size={15} />
                        {String(row.name)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <button
                        className="text-link"
                        onClick={() => {
                          void inspect(row, true);
                        }}
                      >
                        {String(row.actor_type)} / {fmt(row.actor_id)}
                      </button>
                    </TableCell>
                    <TableCell className="mono small">{short(row.message_type)}</TableCell>
                    <TableCell className="mono">
                      {new Date(String(row.due_at)).toLocaleString()}
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell>
                      <button
                        className="invocation-button mono"
                        onClick={() => {
                          void inspect(row);
                        }}
                      >
                        <span className="table-icon">
                          <ArrowDownLeft size={14} />
                        </span>
                        <span title={String(row.invocation_id)}>
                          {String(row.invocation_id).length > 28
                            ? `${String(row.invocation_id).slice(0, 24)}…`
                            : String(row.invocation_id)}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <button
                        className="actor-cell"
                        onClick={() => {
                          void inspect(row, true);
                        }}
                      >
                        <span className="type-pill">{String(row.actor_type)}</span>
                        <span>{fmt(row.actor_id)}</span>
                      </button>
                    </TableCell>
                    <TableCell className="mono small">{short(row.message_type)}</TableCell>
                    <TableCell>
                      <Status status={String(row.status)} />
                    </TableCell>
                    <TableCell className="mono muted">{time(row.accepted_at)}</TableCell>
                  </>
                )}
                <TableCell>
                  <button
                    className="row-arrow"
                    aria-label={`Inspect ${view === 'Actors' || view === 'Reminders' ? fmt(row.actor_id) : String(row.invocation_id)}`}
                    onClick={() => {
                      void inspect(row, view === 'Actors' || view === 'Reminders');
                    }}
                  >
                    <ChevronRight size={15} />
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="table-footer">
        <span>
          {view === 'Overview'
            ? 'Latest accepted messages across all actor types'
            : `Showing ${rows.length ? offset + 1 : 0}–${offset + rows.length} records`}
        </span>
        {view !== 'Overview' && (
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset((n) => Math.max(0, n - 20))}
            >
              <ChevronLeft size={13} />
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={rows.length < 20}
              onClick={() => setOffset((n) => n + 20)}
            >
              Next
              <ChevronRight size={13} />
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
