#!/usr/bin/env node
// ============================================================================
// GPD backend doctor — verifies the Supabase project the web client talks to.
//
// The browser can only ever report "something went wrong": it holds the
// publishable key, which cannot read the schema or create tables. This script
// probes the project over REST with the same publishable key the client uses and
// says exactly what is missing and how to fix it.
//
// Usage:
//   node tools/check-supabase.mjs
//   SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... node tools/check-supabase.mjs
//
// Exits non-zero when the backend is not ready for online play.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(here, '..', 'gpd', '.env');

function fromEnvFile(key) {
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.indexOf('=');
      if (i > 0 && trimmed.slice(0, i).trim() === key) return trimmed.slice(i + 1).trim();
    }
  } catch { /* no .env is fine if the vars are exported */ }
  return undefined;
}

const URL_ = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? fromEnvFile('VITE_SUPABASE_URL') ?? '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? fromEnvFile('VITE_SUPABASE_PUBLISHABLE_KEY') ?? '';

if (!URL_ || !KEY) {
  console.error('No Supabase URL/key. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (or write gpd/.env).');
  process.exit(2);
}
if (KEY.startsWith('sb_secret_') || KEY.startsWith('eyJ') === false && KEY.length > 60) {
  // A service-role key would trivially pass every check and prove nothing about what
  // players can do, so warn instead of silently "succeeding".
  console.warn('Note: this looks like a secret/service key. The doctor is meant to run with the publishable key.\n');
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const ok = (s) => s >= 200 && s < 300;
let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

async function head(path_) {
  const res = await fetch(`${URL_}/rest/v1/${path_}`, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

// ------------------------------------------------------------------ reachable
console.log(`GPD backend doctor\nproject: ${URL_}\nkey:     ${KEY.slice(0, 14)}…\n`);
console.log('1. Project reachable');
try {
  const res = await fetch(`${URL_}/rest/v1/games?select=id&limit=1`, { headers });
  if (res.status === 401 || res.status === 403) fail(`Auth rejected the key (HTTP ${res.status}). Check VITE_SUPABASE_PUBLISHABLE_KEY.`);
  else pass(`REST API responded (HTTP ${res.status})`);
} catch (e) {
  fail(`Cannot reach ${URL_} — ${e.message}`);
  console.log('\nBackend is not ready. Stopping here.');
  process.exit(1);
}

// -------------------------------------------------------------------- tables
const TABLES = [
  'profiles', 'games', 'game_players', 'game_invites', 'game_secrets',
  'scoring_rules', 'score_events', 'messages', 'friendships', 'notifications',
];
const VIEWS = ['leaderboard'];

console.log('\n2. Tables and views');
const missing = [];
for (const t of [...TABLES, ...VIEWS]) {
  const { status, body } = await head(`${t}?select=*&limit=1`);
  if (ok(status)) pass(t);
  else if (status === 404 || body?.code === 'PGRST205') { fail(`${t} — not found in the schema cache`); missing.push(t); }
  else if (status === 401 || status === 403) pass(`${t} (exists; RLS hides rows)`);
  else fail(`${t} — HTTP ${status} ${body?.message ?? ''}`);
}

if (missing.length) {
  const all = missing.length === TABLES.length + VIEWS.length;
  console.log(`\n${all ? 'The schema has never been applied to this project.' : 'Some objects are missing.'}`);
  console.log('Apply it with either:');
  console.log('  psql "$SUPABASE_DB_URL" -f supabase/schema.sql');
  console.log('  or paste supabase/schema.sql into the Supabase dashboard → SQL editor → Run.');
  console.log('\nBackend is not ready for online play.');
  process.exit(1);
}

// ----------------------------------------------------------------- functions
console.log('\n3. SQL functions');
const BOGUS = '00000000-0000-0000-0000-000000000000';
async function rpc(fn, args) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body is fine (204) */ }
  return { status: res.status, body };
}

const join = await rpc('join_game', { p_game: BOGUS, p_seat: 1, p_team: 0, p_password: '' });
if (join.status === 404 || join.body?.code === 'PGRST202') fail('join_game() — missing');
else if (join.body?.code === '42883' || String(join.body?.message ?? '').includes('does not exist')) fail(`join_game() — ${join.body.message}`);
else pass(`join_game() → ${JSON.stringify(join.body)}`);

// set_game_password hashes room passwords with pgcrypto, which Supabase installs in
// the `extensions` schema. A security-definer function pinned to
// `search_path = public` therefore fails with "function gen_salt(unknown) does not
// exist" — but only once a real host tries to set a password, because the host guard
// raises before pgcrypto is reached. gpd_healthcheck() reports the effective
// search_path so it can be caught here instead.
const health = await rpc('gpd_healthcheck', {});
if (health.status === 404 || health.body?.code === 'PGRST202') {
  fail('gpd_healthcheck() — missing; this schema is older than the client expects');
  console.log('        Re-apply supabase/schema.sql to bring the project up to date.');
} else if (!ok(health.status)) {
  fail(`gpd_healthcheck() — HTTP ${health.status} ${health.body?.message ?? ''}`);
} else {
  const h = health.body ?? {};
  const crypto = h.pgcrypto_schema ?? 'public';
  pass(`gpd_healthcheck() → schema ${h.schema}, ${h.tables} tables, ${h.rules} rule set(s), pgcrypto in "${crypto}"`);
  const needsCrypto = ['set_game_password', 'join_game'];
  for (const fn of needsCrypto) {
    const path = h.search_paths?.[fn] ?? '';
    if (path.includes(crypto)) pass(`${fn}() — search_path includes "${crypto}"`);
    else {
      fail(`${fn}() — search_path is "${path || '(unset)'}", which cannot see pgcrypto in "${crypto}"`);
      console.log('        Fix: re-apply supabase/schema.sql (the security-definer functions must use');
      console.log(`        \`security definer set search_path = public, ${crypto}\`).`);
    }
  }
}

// --------------------------------------------------------------- seed data
console.log('\n4. Seed data');
const rules = await head('scoring_rules?select=id,name&id=eq.default');
if (ok(rules.status) && Array.isArray(rules.body) && rules.body.length === 1) pass(`scoring_rules default row present (${rules.body[0].name})`);
else fail('scoring_rules has no "default" row');

// ------------------------------------------------------------------- summary
console.log(failures ? `\n${failures} check(s) failed — online play will not work until they are fixed.` : '\nAll checks passed — online lobbies, passwords, invitations and the leaderboard are ready.');
process.exit(failures ? 1 : 0);
