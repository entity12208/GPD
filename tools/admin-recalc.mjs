#!/usr/bin/env node
// ============================================================================
// GPD admin: rescore the whole leaderboard with a different rule set.
//
// This is the ONLY supported way to change point values. It needs the
// service-role key, which must never ship with any client (web or desktop).
// Players cannot change scoring from inside the game — there is no UI for it.
//
// Usage:
//   SUPABASE_URL=https://<project>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
//   node tools/admin-recalc.mjs \
//     --rules default \
//     --claim-unoccupied 60 --lose-country -60 --claim-occupied 90 \
//     --fail-to-win -25 --claim-continent 250 --win-game 600 --lose-game -250
//
// Omit the point flags to just rebuild the leaderboard from the stored events.
// ============================================================================

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role only — never a publishable key).');
  process.exit(1);
}
if (KEY.startsWith('sb_publishable_')) {
  console.error('That is a publishable key. Recalculation requires the service-role key.');
  process.exit(1);
}

const rulesId = flag('rules', 'default');
const COLUMNS = {
  'claim-unoccupied': 'claim_unoccupied',
  'lose-country': 'lose_country',
  'claim-occupied': 'claim_occupied',
  'fail-to-win': 'fail_to_win',
  'claim-continent': 'claim_continent',
  'win-game': 'win_game',
  'lose-game': 'lose_game',
};

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const patch = {};
for (const [flagName, column] of Object.entries(COLUMNS)) {
  const value = flag(flagName);
  if (value !== undefined) {
    const n = Number(value);
    if (!Number.isFinite(n)) { console.error(`--${flagName} must be a number, got "${value}"`); process.exit(1); }
    patch[column] = n;
  }
}

if (Object.keys(patch).length) {
  const res = await fetch(`${URL}/rest/v1/scoring_rules?id=eq.${encodeURIComponent(rulesId)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) { console.error('Updating scoring rules failed:', res.status, await res.text()); process.exit(1); }
  console.log(`Updated scoring rules "${rulesId}":`, patch);
} else {
  console.log(`No point changes requested; rebuilding the leaderboard with rules "${rulesId}".`);
}

const recalc = await fetch(`${URL}/rest/v1/rpc/recalculate_leaderboard`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ p_rules_id: rulesId }),
});
if (!recalc.ok) { console.error('Recalculation failed:', recalc.status, await recalc.text()); process.exit(1); }

const board = await fetch(`${URL}/rest/v1/leaderboard?select=username,global_score,rank&order=rank.asc&limit=20`, { headers });
const rows = board.ok ? await board.json() : [];
console.log('Leaderboard rebuilt. Top rows:');
for (const row of rows) console.log(`  ${row.rank}. ${row.username} — ${row.global_score} pts`);
