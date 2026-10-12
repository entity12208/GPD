import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChannel {
  listeners: Record<string, (a: unknown) => void>;
  sends: { type?: string; event?: string; payload?: unknown }[];
  subscribeCb: ((s: string) => void) | null;
  on(t: string, f: { event: string }, cb: (a: unknown) => void): FakeChannel;
  subscribe(cb: (s: string) => void): FakeChannel;
  send(msg: unknown): Promise<string>;
}

const h = vi.hoisted(() => ({ created: [] as unknown[] }));

vi.mock('../supabase', () => ({
  supabase: {
    channel: () => {
      const ch = { listeners: {}, sends: [], subscribeCb: null } as unknown as FakeChannel;
      ch.on = (_t, f, cb) => { ch.listeners[f.event] = cb; return ch; };
      ch.subscribe = (cb) => { ch.subscribeCb = cb; return ch; };
      ch.send = (msg) => { ch.sends.push(msg as FakeChannel['sends'][number]); return Promise.resolve('ok'); };
      h.created.push(ch);
      return ch;
    },
    removeChannel: () => {},
  },
}));

const { CHANNEL_READY_TIMEOUT_MS, openGameChannel } = await import('../online');
const last = () => h.created[h.created.length - 1] as FakeChannel;

beforeEach(() => { h.created.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('openGameChannel', () => {
  it('resolves ready=true once Realtime subscribes', async () => {
    const c = openGameChannel('g1', 'me', {});
    last().subscribeCb?.('SUBSCRIBED');
    await expect(c.ready).resolves.toBe(true);
  });

  it('settles ready=false instead of hanging when Realtime never subscribes', async () => {
    vi.useFakeTimers();
    const c = openGameChannel('g2', 'me', {});
    vi.advanceTimersByTime(CHANNEL_READY_TIMEOUT_MS + 1);
    await expect(c.ready).resolves.toBe(false);
  });

  it('settles ready=false when the channel errors', async () => {
    const c = openGameChannel('g3', 'me', {});
    last().subscribeCb?.('CHANNEL_ERROR');
    await expect(c.ready).resolves.toBe(false);
  });

  it('requestState() asks the host for a snapshot', () => {
    const c = openGameChannel('g4', 'user-7', {});
    c.requestState();
    expect(last().sends).toEqual([{ type: 'broadcast', event: 'hello', payload: { from: 'user-7' } }]);
  });

  it('invokes onHello for the host when a guest asks for the state', () => {
    const hellos: string[] = [];
    openGameChannel('g5', 'host', { onHello: (from) => hellos.push(from) });
    last().listeners.hello({ payload: { from: 'guest-1' } });
    expect(hellos).toEqual(['guest-1']);
  });

  it('routes state, action and chat broadcasts to their handlers', () => {
    const seen: string[] = [];
    openGameChannel('g6', 'me', {
      onState: (_s, status) => seen.push(`state:${status}`),
      onAction: (_p, from) => seen.push(`action:${from}`),
      onChat: (m) => seen.push(`chat:${m.from}`),
    });
    const ch = last();
    ch.listeners.state({ payload: { state: {}, status: 'active' } });
    ch.listeners.action({ payload: { payload: { t: 'nothing' }, from: '5' } });
    ch.listeners.chat({ payload: { body: 'hi', team: null, from: '9' } });
    expect(seen).toEqual(['state:active', 'action:5', 'chat:9']);
  });

  it('broadcasts the authoritative snapshot with the requested status', () => {
    const c = openGameChannel('g7', 'host', {});
    c.sendState({ round: 2 } as never, 'placement');
    expect(last().sends[0]).toMatchObject({ event: 'state', payload: { status: 'placement' } });
  });
});
