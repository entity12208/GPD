"""Rulebook tests for the desktop engine."""

from __future__ import annotations

import pytest

from gpd_desktop import mapdata as geo
from gpd_desktop.engine import (
    DEFAULT_SCORING, EXPAND_BASE, OCEAN_PER_TROOP, SEA_EXTRA, STARTING_MONEY, TROOP_COST,
    GPDGame, GameConfig, ScoringRules,
)
from gpd_desktop.sim import run_simulation
from gpd_desktop.bots import bot_act


def make_game(**kw) -> GPDGame:
    base = dict(map_preset="World", mode="offline-multi", timer="none",
                human_players=2, seed=12345)
    base.update(kw)
    return GPDGame(GameConfig(**base))


def placed(game: GPDGame, picks) -> GPDGame:
    for cid in picks:
        actor = game.actor
        ok, err = game.place_starting_country(actor.id, cid)
        assert ok, err
    return game


# ------------------------------------------------------------------ map data --
def test_country_set_is_usable():
    assert len(geo.ALL_COUNTRIES) > 150
    for c in geo.ALL_COUNTRIES:
        assert c.name
        assert c.land or c.sea
        assert -90 <= c.lat <= 90


@pytest.mark.parametrize("preset", [p[0] for p in geo.MAP_PRESETS])
def test_presets_are_non_empty_and_connected(preset):
    g = geo.graph_for_preset(preset)
    assert g.ids
    seen = {g.ids[0]}
    queue = [g.ids[0]]
    while queue:
        cur = queue.pop()
        for lane in g.adj[cur]:
            if lane.id not in seen:
                seen.add(lane.id)
                queue.append(lane.id)
    assert seen == set(g.ids)


def test_lane_kinds():
    world = geo.graph_for_preset("World")
    assert world.lane("USA", "CAN").water is None
    assert world.lane("FRA", "GBR").water == "sea"
    assert any(l.water == "ocean" for l in world.adj["RUS"])


# -------------------------------------------------------------------- setup --
def test_starting_position_and_money():
    g = placed(make_game(), ["USA", "CAN"])
    assert g.phase == "awaiting-action"
    for p in g.players:
        assert p.money == STARTING_MONEY
        assert p.alive
    assert g.territories["USA"].owner == 0
    assert g.territories["USA"].troops == 1
    assert g.territories["BRA"].owner is None


def test_duplicate_start_is_rejected():
    g = make_game()
    assert g.place_starting_country(g.actor.id, "USA")[0]
    assert not g.place_starting_country(g.actor.id, "USA")[0]
    assert g.place_starting_country(g.actor.id, "CAN")[0]


# -------------------------------------------------------------------- peace --
def test_peace_marks_vulnerable_and_pays_next_turn():
    g = placed(make_game(), ["USA", "CAN"])
    ok, _ = g.submit_peace("USA")
    assert ok
    assert g.territories["USA"].vulnerable
    assert g.players[0].pending_peace
    g.submit_nothing()
    assert g.current_player.id == 0
    assert g.players[0].money == STARTING_MONEY + 100
    assert not g.territories["USA"].vulnerable


def test_continent_income_bonus():
    g = placed(make_game(), ["AUS", "USA"])
    oceania = geo.countries_for_preset("Oceania")
    for c in oceania:
        if c.id != "AUS":
            g.territories[c.id].owner = 0
            g.territories[c.id].troops = 1
    g.sync_continents(0)
    g.players[0].pending_peace = True
    g.end_turn()
    g.end_turn()
    size = len(oceania)
    assert g.current_player.id == 0
    assert g.players[0].money == STARTING_MONEY + 100 * size + 10 * size
    assert "Oceania" in g.players[0].continents


# ------------------------------------------------------------------- gather --
def test_gather_cap_and_cost():
    g = placed(make_game(), ["USA", "CAN"])
    ok, _ = g.choose_action("gather")
    assert ok
    assert 1 <= g.gather_cap <= 20
    cid = g.owned_by(0)[0].id
    ok, err = g.submit_gather({cid: 1})
    assert ok, err
    assert g.players[0].money == STARTING_MONEY - TROOP_COST
    assert g.territories[cid].troops == 2


def test_gather_rejects_over_cap_and_overspend():
    g = placed(make_game(map_preset="Oceania", human_players=1, player_count=1), ["AUS"])
    g.players[0].money = 5000
    g.choose_action("gather")
    cap = g.gather_cap
    assert not g.submit_gather({"AUS": cap + 1})[0]
    g.players[0].money = 10
    assert not g.submit_gather({"AUS": 2})[0]


# ------------------------------------------------------------------- expand --
def test_land_expansion_costs_100():
    g = placed(make_game(), ["USA", "CAN"])
    g.territories["USA"].troops = 3
    ok, err = g.submit_expand("USA", "CAN", 2)
    assert ok, err
    assert g.territories["CAN"].owner == 0
    assert g.territories["USA"].troops == 1
    assert g.players[0].money == STARTING_MONEY - EXPAND_BASE


def test_water_and_ocean_pricing():
    g = placed(make_game(human_players=1, player_count=1, map_preset="Europe"), ["FRA"])
    g.territories["FRA"].troops = 5
    q = g.quote_expand(0, "FRA", "GBR", 2)
    assert not isinstance(q, str)
    assert q.water == "sea" and q.water_fee == SEA_EXTRA
    assert q.total == EXPAND_BASE + SEA_EXTRA

    g2 = placed(make_game(human_players=1, player_count=1), ["RUS"])
    g2.territories["RUS"].troops = 6
    q2 = g2.quote_expand(0, "RUS", "KGZ", 4)
    assert not isinstance(q2, str)
    assert q2.water == "ocean"
    assert q2.total == EXPAND_BASE + OCEAN_PER_TROOP * 4


def test_cannot_expand_through_other_countries():
    g = placed(make_game(), ["USA", "CAN"])
    ok, err = g.submit_expand("USA", "BRA", 1)
    assert not ok
    assert "border" in err or "through" in err


def test_garrison_limits():
    g = placed(make_game(), ["USA", "CAN"])
    g.territories["USA"].troops = 3
    assert not g.submit_expand("USA", "CAN", 3)[0]
    g.territories["MEX"].owner = 0
    g.territories["MEX"].troops = 1
    assert not g.submit_expand("USA", "MEX", 1)[0]


def test_sea_attrition_is_about_one_in_ten():
    sent = 0
    arrived = 0
    for seed in range(1, 201):
        g = placed(make_game(human_players=1, player_count=1, seed=seed), ["JPN"])
        g.territories["JPN"].troops = 25
        g.players[0].money = 100000
        ok, err = g.submit_expand("JPN", "KOR", 20)
        assert ok, err
        sent += 20
        arrived += g.territories["KOR"].troops
    rate = 1 - arrived / sent
    assert 0.05 < rate < 0.16


# ------------------------------------------------------------------- combat --
def test_vulnerable_country_is_wiped_without_dice():
    g = placed(make_game(), ["USA", "CAN"])
    g.territories["USA"].troops = 4
    g.territories["CAN"].troops = 5
    g.territories["CAN"].vulnerable = True
    assert g.submit_expand("USA", "CAN", 3)[0]
    assert g.territories["CAN"].owner == 0
    assert g.territories["CAN"].troops == 3


def test_dice_battle_scores_correctly():
    g = placed(make_game(player_count=3), ["USA", "MEX", "CAN"])
    g.territories["USA"].troops = 10
    g.territories["CAN"].troops = 1
    g.players[0].money = 1000
    before = g.players[0].score
    assert g.submit_expand("USA", "CAN", 9)[0]
    claimed = g.territories["CAN"].owner == 0
    expected = DEFAULT_SCORING.claim_occupied if claimed else DEFAULT_SCORING.fail_to_win
    assert g.players[0].score == before + expected
    if claimed:
        assert g.players[2].score == DEFAULT_SCORING.lose_country
    assert any(e.type == "combat" and "Battle for" in e.text for e in g.log)


def test_misspelled_typed_order_loses_the_turn():
    g = placed(make_game(), ["USA", "CAN"])
    g.territories["USA"].troops = 3
    ok, _ = g.submit_expand("USA", "CAN", 1, typed="Cananda")
    assert not ok
    assert any(e.type == "forfeit" for e in g.log)
    assert g.current_player.id == 1
    assert g.territories["CAN"].owner == 1
    assert g.players[0].money == STARTING_MONEY


def test_correct_typed_order_is_accepted():
    g = placed(make_game(), ["USA", "CAN"])
    g.territories["USA"].troops = 3
    assert g.submit_expand("USA", "CAN", 1, typed="canada")[0]
    assert g.territories["CAN"].owner == 0


# ------------------------------------------------------------------ scoring --
def test_documented_point_values():
    g = placed(make_game(), ["USA", "CAN"])
    g.players[0].score_raw = 0
    for key in ("claim_unoccupied", "claim_occupied", "lose_country", "fail_to_win", "claim_continent"):
        g.award(0, key)
    assert g.players[0].score == 50 + 75 - 50 - 20 + 200
    assert g.calculate_score(0, DEFAULT_SCORING, 1.5) == round(255 * 1.5)


def test_recalculation_from_a_different_rule_set():
    g = placed(make_game(player_count=3), ["USA", "MEX", "CAN"])
    g.territories["USA"].troops = 6
    g.submit_expand("USA", "CAN", 5)
    standard = [p.score for p in g.players]
    g.recalculate(ScoringRules(claim_unoccupied=50, lose_country=-1000, claim_occupied=1000,
                               fail_to_win=-20, claim_continent=200, win_game=500, lose_game=-200))
    custom = [p.score for p in g.players]
    assert custom != standard
    assert custom[0] == 1000
    g.recalculate(DEFAULT_SCORING)
    assert [p.score for p in g.players] == standard


def test_continent_bonus_awarded_once():
    g = placed(make_game(), ["AUS", "USA"])
    for c in geo.countries_for_preset("Oceania"):
        if c.id != "AUS":
            g.territories[c.id].owner = 0
            g.territories[c.id].troops = 1
    g.players[0].money = 5000
    g.sync_continents(0)
    after_claim = g.players[0].score
    assert after_claim == DEFAULT_SCORING.claim_continent
    g.territories["AUS"].troops = 6
    assert g.submit_expand("AUS", "TLS", 5)[0]
    assert g.players[0].score == after_claim + DEFAULT_SCORING.claim_unoccupied


# ------------------------------------------------------------------ timers ---
def test_missing_the_deadline_kicks_the_player():
    g = placed(make_game(timer="1min"), ["USA", "CAN"])
    g.territories["MEX"].owner = 0
    g.territories["MEX"].troops = 2
    assert g.tick(now=g.turn_deadline + 1)
    assert not g.players[0].alive
    assert not g.owned_by(0)
    assert any(e.type == "timeout" for e in g.log)


def test_timer_waits_for_the_deadline():
    g = placed(make_game(timer="5min"), ["USA", "CAN"])
    assert not g.tick()
    assert g.players[0].alive


# ------------------------------------------------------------- vision -------
def test_fog_of_war_and_blindfold():
    g = placed(make_game(fog_of_war=True), ["USA", "CAN"])
    fog = g.view_for(0)
    assert fog["visible"]["USA"]["troops"] == 1
    assert fog["visible"]["CAN"]["troops"] is None

    b = placed(make_game(blindfold=True), ["USA", "CAN"])
    blind = b.view_for(0)
    assert blind["visible"]["USA"]["owner"] is None
    assert blind["visible"]["USA"]["troops"] is None


def test_marker_on_team_events():
    g = placed(make_game(fog_of_war=True), ["USA", "CAN"])
    g.territories["USA"].troops = 3
    g.submit_expand("USA", "CAN", 2)
    assert any(m["territory"] == "CAN" for m in g.markers)


# ------------------------------------------------------------- full games ----
@pytest.mark.parametrize("preset", ["World", "Europe", "Asia", "Oceania"])
def test_bot_games_always_finish_with_one_winner(preset):
    seats = 4 if preset == "Oceania" else 8
    g = GPDGame(GameConfig(map_preset=preset, mode="offline-sim", human_players=0,
                           player_count=seats, seed=1))
    result = run_simulation(g)
    assert result.finished, preset
    assert result.winner is not None or result.winning_team is not None
    alive = [p for p in g.players if p.alive]
    assert len(alive) == 1
    assert alive[0].score > 0


def test_tournament_games_end_with_a_winning_team():
    g = GPDGame(GameConfig(map_preset="Europe", mode="offline-sim", human_players=0,
                           player_count=12, tournament=True, seed=4242))
    result = run_simulation(g)
    assert result.finished
    assert result.winning_team is not None
    survivors = [p for p in g.players if p.alive]
    assert len({p.team for p in survivors}) == 1


def test_same_seed_is_deterministic():
    def run():
        g = GPDGame(GameConfig(map_preset="Africa", mode="offline-sim", human_players=0,
                               player_count=8, seed=555))
        return run_simulation(g)

    a, b = run(), run()
    assert (a.steps, a.winner, [s["score"] for s in a.standings]) == \
           (b.steps, b.winner, [s["score"] for s in b.standings])


def test_elimination_when_last_country_is_lost():
    g = placed(make_game(player_count=3), ["USA", "MEX", "CAN"])
    g.territories["USA"].troops = 12
    g.territories["CAN"].troops = 1
    assert g.submit_expand("USA", "CAN", 11)[0]
    assert not g.players[2].alive
    assert any(e.type == "eliminated" for e in g.log)


def test_snapshot_round_trip_preserves_state_and_rng():
    import json
    g = GPDGame(GameConfig(map_preset="Oceania", mode="offline-sim", human_players=0,
                           player_count=4, seed=7))
    for _ in range(12):
        if g.actor is None:
            break
        bot_act(g)
    clone = GPDGame.from_dict(json.loads(json.dumps(g.to_dict())))
    assert clone.round == g.round
    assert clone.phase == g.phase
    assert clone.rng.s == g.rng.s
    assert len(clone.territories) == len(g.territories)
    # Both continue identically from the same PRNG state.
    next_a = g.rng.int(1, 20)
    next_b = clone.rng.int(1, 20)
    assert next_a == next_b
