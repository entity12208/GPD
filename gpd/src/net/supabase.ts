import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? '';

export const isSupabaseConfigured = Boolean(URL && KEY);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(URL, KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null;

/**
 * A GPD account is an email address, a unique username and a password. The
 * email is required for both sign up and sign in; the username is what other
 * players see and what the leaderboard ranks by.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/**
 * Supabase and PostgREST never throw `Error` instances: failures come back as
 * plain objects shaped `{ message, details, hint, code }`, so `e instanceof Error`
 * is false for them. Pull the real message out of whatever was thrown instead of
 * collapsing every failure into one generic string.
 */
export function errorMessage(e: unknown, fallback = 'Something went wrong.'): string {
  if (typeof e === 'string' && e.trim()) return e;
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; error_description?: unknown; hint?: unknown; details?: unknown };
    const base = typeof o.message === 'string' && o.message ? o.message
      : typeof o.error_description === 'string' ? o.error_description : '';
    const extra = typeof o.hint === 'string' && o.hint ? o.hint
      : typeof o.details === 'string' && o.details ? o.details : '';
    if (base && extra && !base.includes(extra)) return `${base} — ${extra}`;
    if (base) return base;
    if (extra) return extra;
  }
  return fallback;
}

export interface Profile {
  id: string;
  username: string;
  global_score: number;
}

export async function signUp(email: string, username: string, password: string) {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { username: username.trim() } },
  });
}

export async function signIn(email: string, password: string) {
  if (!supabase) throw new Error('Supabase is not configured');
  return supabase.auth.signInWithPassword({ email: email.trim(), password });
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function currentProfile(): Promise<Profile | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return null;
  const { data: rows } = await supabase
    .from('profiles')
    .select('id, username, global_score')
    .eq('id', user.id)
    .maybeSingle();
  if (rows) return rows as Profile;
  const username = (user.user_metadata?.username as string | undefined) ?? user.email?.split('@')[0] ?? 'player';
  await supabase.from('profiles').upsert({ id: user.id, username });
  return { id: user.id, username, global_score: 0 };
}
