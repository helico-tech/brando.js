import { Badge } from '../components/ui/badge.js';
import { Boxes } from 'lucide-react';
export const fmt = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
export const num = (value: unknown) => Number(value ?? 0).toLocaleString();
export const time = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
export const short = (value: unknown) => String(value ?? '').replace('brando.primitives.', '');
export function sample(schema: Record<string, unknown>): unknown {
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>).map(
        ([key, value]) => [key, sample(value)],
      ),
    );
  if (schema.type === 'array') return [];
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'string') return '';
  return null;
}
export function Status({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={`status status-${status.toLowerCase()}`}>
      <span className="status-dot" />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </Badge>
  );
}
export function Empty({
  text = 'No records yet',
  description = 'Submit a message to start an actor’s durable history.',
}: {
  text?: string;
  description?: string;
}) {
  return (
    <div className="empty">
      <Boxes size={28} />
      <strong>{text}</strong>
      <p>{description}</p>
    </div>
  );
}
