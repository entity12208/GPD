import { useState } from 'react';
import { errorMessage, isSupabaseConfigured, isValidEmail, signIn, signUp, supabase } from '../net/supabase';
import type { LocalProfile } from '../state/local';
import { sfx } from '../state/sfx';

interface Props {
  onSignedIn: (p: LocalProfile) => void;
  onGuest: () => void;
}

export function Auth({ onSignedIn, onGuest }: Props) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ kind: 'bad' | 'good' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setMsg(null);
    // Email is required for both sign up and sign in.
    if (!isValidEmail(email)) { setMsg({ kind: 'bad', text: 'Enter a valid email address.' }); return; }
    if (mode === 'up' && username.trim().length < 3) { setMsg({ kind: 'bad', text: 'Username must be at least 3 characters.' }); return; }
    if (password.length < 6) { setMsg({ kind: 'bad', text: 'Password must be at least 6 characters.' }); return; }
    if (!isSupabaseConfigured || !supabase) {
      setMsg({ kind: 'warn', text: 'Supabase is not configured — online accounts are unavailable. Use Guest to play offline modes.' });
      return;
    }
    setBusy(true);
    try {
      if (mode === 'up') {
        const { data, error } = await signUp(email.trim(), username.trim(), password);
        if (error) throw error;
        if (!data.session) {
          setMsg({ kind: 'warn', text: 'Account created. Confirm your email address (or ask the operator to disable confirmation) before signing in.' });
          sfx('error');
          return;
        }
        await supabase.from('profiles').upsert({ id: data.session.user.id, username: username.trim() });
        onSignedIn({ username: username.trim(), createdAt: new Date().toISOString(), remoteId: data.session.user.id });
      } else {
        const { data, error } = await signIn(email.trim(), password);
        if (error) throw error;
        const name = (data.user?.user_metadata?.username as string | undefined) ?? username.trim() ?? 'player';
        onSignedIn({ username: name || 'player', createdAt: new Date().toISOString(), remoteId: data.session?.user.id });
      }
      sfx('win');
    } catch (e) {
      sfx('error');
      setMsg({ kind: 'bad', text: errorMessage(e, 'Sign in failed') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="menu" style={{ maxWidth: 520, margin: '40px auto' }}>
      <div className="card card--wide">
        <h3>{mode === 'in' ? 'Sign In' : 'Sign Up'}</h3>
        <p>An email address, a username and a password are required for online games. Offline modes work without an account.</p>
        <div className="stack">
          <label className="field">Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
              placeholder="you@example.com" required />
          </label>
          {mode === 'up' && (
            <label className="field">Username
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
            </label>
          )}
          <label className="field">Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
              onKeyDown={(e) => e.key === 'Enter' && void submit()} />
          </label>
          {msg && <div className={`notice notice--${msg.kind}`}>{msg.text}</div>}
          {!isSupabaseConfigured && <div className="notice notice--warn">No Supabase URL/key configured. Copy <span className="mono">.env.example</span> to <span className="mono">.env</span> to enable online play.</div>}
          <button className="btn btn--primary btn--block" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Working…' : mode === 'in' ? 'Sign In' : 'Create account'}
          </button>
          <div className="btn-row">
            <button className="btn btn--sm" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
              {mode === 'in' ? 'Need an account? Sign up' : 'Already registered? Sign in'}
            </button>
            <button className="btn btn--sm btn--ghost" onClick={onGuest}>Play offline as Guest</button>
          </div>
        </div>
      </div>
    </div>
  );
}
