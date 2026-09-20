import { useState, type FormEvent } from 'react';
import type { Catalogue } from '../types.js';
import { sample } from '../lib/presentation.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Textarea } from './ui/textarea.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Loader2, Send, ShieldCheck } from 'lucide-react';
export function SubmitDialog({
  open,
  onOpenChange,
  catalogue,
  api,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogue: Catalogue;
  api: <T>(path: string, body?: unknown) => Promise<T>;
  onSuccess: (id: string) => void;
}) {
  const [actorName, setActorName] = useState('counter');
  const [messageName, setMessageName] = useState('counter.add');
  const [id, setId] = useState('"my-counter"');
  const [payload, setPayload] = useState('{\n  "amount": 1\n}');
  const [invocationId, setInvocationId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const actor = catalogue.find((a) => a.name === actorName) ?? catalogue[0];
  const msg = actor?.messages.find((m) => m.name === messageName) ?? actor?.messages[0];
  function changeActor(value: string) {
    setActorName(value);
    const a = catalogue.find((c) => c.name === value)!;
    setId(JSON.stringify(sample(a.idSchema)));
    setMessageName(a.messages[0]!.name);
    setPayload(JSON.stringify(sample(a.messages[0]!.payloadSchema), null, 2));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ invocationId: string }>('/submit', {
        actorType: actor?.name,
        id: JSON.parse(id),
        messageType: msg?.name,
        payload: JSON.parse(payload),
        ...(invocationId ? { invocationId } : {}),
      });
      onSuccess(result.invocationId);
      onOpenChange(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="submit-dialog">
        <DialogHeader>
          <div className="dialog-symbol">
            <Send size={20} />
          </div>
          <DialogTitle>Send a message</DialogTitle>
          <DialogDescription>
            Submit a typed message to an actor’s durable mailbox.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <div className="form-grid">
            <label>
              Actor type
              <select
                aria-label="Actor type"
                value={actor?.name ?? ''}
                onChange={(event) => changeActor(event.target.value)}
              >
                {catalogue.map((a) => (
                  <option key={a.name}>{a.name}</option>
                ))}
              </select>
            </label>
            <label>
              Actor ID <span className="muted">JSON</span>
              <Input
                aria-label="Actor ID"
                className="mono"
                value={id}
                onChange={(event) => setId(event.target.value)}
                required
              />
            </label>
          </div>
          <label>
            Message type
            <select
              aria-label="Message type"
              value={msg?.name ?? ''}
              onChange={(event) => {
                setMessageName(event.target.value);
                const message = actor!.messages.find((m) => m.name === event.target.value)!;
                setPayload(JSON.stringify(sample(message.payloadSchema), null, 2));
              }}
            >
              {actor?.messages.map((m) => (
                <option key={m.name}>{m.name}</option>
              ))}
            </select>
          </label>
          <label>
            Payload <span className="muted">JSON</span>
            <Textarea
              aria-label="Payload"
              className="mono payload-input"
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              rows={6}
              required
            />
          </label>
          <label>
            Invocation ID <span className="muted">optional</span>
            <Input
              aria-label="Invocation ID"
              value={invocationId}
              onChange={(event) => setInvocationId(event.target.value)}
              placeholder="Auto-generated UUID"
            />
          </label>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="submit-note">
            <ShieldCheck size={15} />
            Acknowledged only after durable acceptance.
          </div>
          <div className="dialog-actions">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !actor}>
              {busy ? <Loader2 className="spin" size={15} /> : <Send size={15} />}Send message
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
