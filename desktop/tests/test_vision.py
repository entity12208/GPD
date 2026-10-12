"""Fog of War / Blindfold must never reveal an unclaimed country's name."""

from __future__ import annotations

from gpd_desktop import mapdata as geo
from gpd_desktop.engine import GPDGame, GameConfig
from gpd_desktop.views import HIDDEN_NAME, hidden_country_names, redact_country_names


def make_game(**kw) -> GPDGame:
    base = dict(map_preset="Europe", mode="offline-multi", timer="none",
                human_players=2, player_count=2, seed=3)
    base.update(kw)
    return GPDGame(GameConfig(**base))


def placed(**kw) -> GPDGame:
    g = make_game(**kw)
    for cid in ["FRA", "DEU"]:
        actor = g.actor
        ok, err = g.place_starting_country(actor.id, cid)
        assert ok, err
    return g


def test_no_modifier_reveals_every_name():
    g = placed()
    assert g.can_see_name(0, "DEU")
    hidden = hidden_country_names(g, 0)
    assert hidden == {}
    assert redact_country_names("Germany", hidden) == "Germany"


def test_fog_of_war_reveals_only_claimed_names():
    g = placed(fog_of_war=True)
    assert g.can_see_name(0, "FRA")
    assert not g.can_see_name(0, "DEU")
    hidden = hidden_country_names(g, 0)
    assert hidden.get("Germany") == HIDDEN_NAME
    assert "France" not in hidden


def test_blindfold_reveals_only_claimed_names():
    g = placed(blindfold=True)
    assert g.can_see_name(1, "DEU")
    assert not g.can_see_name(1, "FRA")
    hidden = hidden_country_names(g, 1)
    assert hidden.get("France") == HIDDEN_NAME
    assert "Germany" not in hidden


def test_redaction_keeps_your_own_names_and_hides_the_rest():
    g = placed(fog_of_war=True)
    hidden = hidden_country_names(g, 0)
    out = redact_country_names("Ada expands from France into Germany with 3 troops", hidden)
    assert out == f"Ada expands from France into {HIDDEN_NAME} with 3 troops"
    assert redact_country_names("Grace claims Spain", hidden) == f"Grace claims {HIDDEN_NAME}"


def test_redaction_matches_longer_names_first():
    g = make_game(map_preset="World", fog_of_war=True)
    hidden = hidden_country_names(g, 99)
    out = redact_country_names("United Kingdom and Guinea-Bissau", hidden)
    assert "United Kingdom" not in out
    assert "Guinea-Bissau" not in out
    assert HIDDEN_NAME in out


def test_typed_orders_do_not_punish_a_name_never_shown():
    g = placed(fog_of_war=True)
    g.players[0].money = 5000
    g.territories["FRA"].troops = 4
    ok, err = g.submit_expand("FRA", "DEU", 1, "who knows")
    assert ok, err
    assert not [e for e in g.log if e.type == "forfeit"]


def test_typed_orders_still_punish_a_visible_misspelling():
    g = placed()
    g.players[0].money = 5000
    g.territories["FRA"].troops = 4
    ok, err = g.submit_expand("FRA", "DEU", 1, "Germny")
    assert not ok
    assert [e for e in g.log if e.type == "forfeit"]


def test_hidden_name_placeholder_matches_every_country_not_owned():
    g = placed(fog_of_war=True)
    hidden = hidden_country_names(g, 0)
    unclaimed = [cid for cid in g.active if g.territories[cid].owner != 0]
    assert len(hidden) == len(unclaimed)
    assert geo.BY_ID["FRA"].name not in hidden
