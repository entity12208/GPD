"""Drive the real Arcade views headlessly and check the player-facing flows."""

from __future__ import annotations

import pytest

from gpd_desktop.engine import GameConfig
from gpd_desktop.state import AppState
from gpd_desktop import views


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("GPD_DATA_DIR", str(tmp_path))
    from gpd_desktop import state as state_module

    state_module.DATA_DIR = tmp_path
    state_module.STATE_FILE = tmp_path / "desktop-state.json"
    app_state = AppState()
    from gpd_desktop.appwindow import GPDApp

    application = GPDApp(app_state)
    yield application
    application.current_view = None


def test_menu_renders_every_entry(app):
    app.show_menu()
    view = app.current_view
    assert isinstance(view, views.MenuView)
    view.on_draw()
    titles = [e[0] for e in views.MenuView.ENTRIES]
    assert titles == ["Play", "Settings", "Stats", "Leaderboard", "Friends", "Notifications",
                      "My Games", "Rules"]
    assert len(view.widgets) >= len(titles)


def test_every_panel_draws(app):
    for panel in ("settings", "stats", "leaderboard", "mygames", "friends", "notifications",
                  "rules", "signin"):
        app.show_panel(panel)
        view = app.current_view
        assert isinstance(view, views.PanelView)
        view.on_draw()
        view.on_mouse_scroll(100, 400, 0, -1)
        for widget in view.widgets:
            widget.draw()


def test_setup_then_placement_and_a_human_turn(app):
    app.show_setup()
    setup = app.current_view
    assert isinstance(setup, views.SetupView)
    setup._set_mode("offline-solo")
    setup._set_map("Europe")
    setup._set_players(3)
    # A fixed seed keeps this walk-through stable: without one the engine seeds from
    # the clock and the Expand step can land on a dice battle it loses.
    setup._set_seed("20261010")
    setup._start()

    game_view = app.current_view
    assert isinstance(game_view, views.GameView)
    assert game_view.game.config.map_preset == "Europe"
    assert len(game_view.game.players) == 4
    assert game_view.game.phase == "placement"
    game_view.on_draw()

    # the human clicks a country on the map to claim it
    game_view._click_country("FRA")
    assert game_view.game.territories["FRA"].owner == 0
    assert any("starts in" in e.text for e in game_view.game.log)

    # bots finish their picks, then it is the human's turn
    for _ in range(400):
        game_view.on_update(0.2)
        if game_view.game.phase == "awaiting-action" and game_view.is_human_turn:
            break
    assert game_view.game.phase == "awaiting-action"
    assert game_view.is_human_turn

    # Gather Troops through the UI
    game_view._choose_gather()
    assert game_view.mode == "gather"
    assert 1 <= game_view.game.gather_cap <= 20
    owned = game_view.game.owned_by(0)[0].id
    game_view._click_country(owned)
    assert game_view.distribution[owned] == 1
    money_before = game_view.game.players[0].money
    game_view._confirm_gather()
    assert game_view.game.players[0].money == money_before - 50
    assert any("gathered" in e.text for e in game_view.game.log)

    # Expand through the UI: pick a source then a bordered target
    for _ in range(600):
        game_view.on_update(0.2)
        if game_view.game.phase == "awaiting-action" and game_view.is_human_turn:
            break
    if game_view.game.phase == "awaiting-action" and game_view.is_human_turn:
        game_view._choose_expand()
        source = next((t for t in game_view.game.owned_by(0) if t.troops >= 2), None)
        if source:
            game_view._click_country(source.id)
            assert game_view.from_id == source.id
            assert game_view._targets()
            target = sorted(game_view._targets())[0]
            game_view.game.players[0].money = 5000
            game_view._click_country(target)
            assert game_view.to_id == target
            # Typed orders are mandatory: expanding without the spelled name is rejected.
            game_view._do_expand()
            assert game_view.game.territories[target].owner != 0
            game_view.typed_field.value = views.geo.BY_ID[target].name
            game_view.on_draw()
            game_view._do_expand()
            assert game_view.game.territories[target].owner == 0


def test_simulation_runs_to_completion_through_the_view(app):
    config = GameConfig(map_preset="Oceania", mode="offline-sim", human_players=0,
                        player_count=4, seed=7)
    app.start_game(config, [f"Bot {i + 1}" for i in range(4)])
    view = app.current_view
    assert isinstance(view, views.GameView)
    for _ in range(4000):
        view.on_update(0.1)
        if view.game.phase == "finished":
            break
    assert view.game.phase == "finished"
    assert view.showing_results
    view.on_draw()
    assert app.state.games, "finished game should be recorded"
    assert app.state.games[0].map_preset == "Oceania"


def test_leaderboard_recalculation_from_different_rules(tmp_path):
    state = AppState()
    state.record_payload = None
    from gpd_desktop.state import GameRecord

    state.record(GameRecord(
        finished_at="2026-01-01T00:00:00", mode="offline-solo", map_preset="Europe", winner=0,
        rounds=12,
        standings=[{"id": 0, "name": "Alice", "score": 250, "is_bot": False},
                   {"id": 1, "name": "Bot 1", "score": 0, "is_bot": True}],
        score_events=[{"player": 0, "key": "claim_unoccupied"},
                      {"player": 0, "key": "claim_continent"}],
        multiplier=1.0,
    ))
    assert state.leaderboard == [{"name": "Alice", "score": 250}]
    state.rebuild_leaderboard({"claim_occupied": 75, "lose_country": -50, "claim_unoccupied": 10,
                               "fail_to_win": -20, "claim_continent": 1000, "win_game": 500,
                               "lose_game": -200}, multiplier_from_game=False)
    assert state.leaderboard == [{"name": "Alice", "score": 1010}]
    assert state.stats()["games"] == 1


def test_settings_toggles_are_applied(app):
    app.show_panel("settings")
    view = app.current_view
    view._set_fps("30")
    assert app.state.settings.fps == 30
    assert abs(app.update_rate - 1 / 30) < 1e-9
    view._set_volume(0.2)
    assert app.state.settings.sfx_volume == 0.2
    view._set_chat(False)
    assert not app.state.settings.live_chat
    view._reset_settings()
    assert app.state.settings.fps == 60


def test_presets_are_the_rulebook_classic_and_tournament(app):
    from gpd_desktop.engine import PRESETS, preset_capacity, timer_allowed
    assert set(PRESETS) == {"classic", "tournament"}
    assert preset_capacity("classic") == 12 and preset_capacity("tournament") == 12
    # Classic allows every timer including "none"; Tournament does not allow "none".
    assert timer_allowed("classic", "none") and timer_allowed("classic", "1min")
    assert not timer_allowed("tournament", "none")
    assert timer_allowed("tournament", "1d") and timer_allowed("tournament", "5min")

    # Choosing the Tournament preset through the setup screen clamps the timer.
    app.show_setup()
    setup = app.current_view
    setup._set_timer("none")
    setup._set_preset("tournament")
    assert setup.timer in PRESETS["tournament"]["timers"]

    # A tournament game builds teams of up to three.
    setup._set_mode("offline-sim")
    setup._set_players(12)
    setup._start()
    game_view = app.current_view
    assert game_view.game.config.tournament
    assert game_view.game.config.preset == "tournament"
    assert max(p.team for p in game_view.game.players) == 3


def test_leaderboard_excludes_bots(app):
    from gpd_desktop.state import GameRecord
    app.state.record(GameRecord(
        finished_at="2026-02-02T00:00:00", mode="offline-solo", map_preset="Europe", winner=0,
        rounds=5,
        standings=[{"id": 0, "name": "Ada", "score": 120, "is_bot": False},
                   {"id": 1, "name": "Bot 1", "score": 900, "is_bot": True}],
        score_events=[{"player": 0, "key": "claim_unoccupied"}],
        multiplier=1.0,
    ))
    names = [row["name"] for row in app.state.leaderboard]
    assert "Ada" in names and "Bot 1" not in names


def test_topbar_shows_notifications(app):
    app.notify("Not enough countries on that map.")
    assert app.toast_text.startswith("Not enough")
    app.show_menu()
    app.current_view.on_draw()


def test_save_and_resume_a_game_through_the_views(app):
    app.show_setup()
    setup = app.current_view
    setup._set_map("Europe")
    setup._set_players(3)
    setup._start()
    view = app.current_view
    assert isinstance(view, views.GameView)
    view._click_country("FRA")
    for _ in range(600):
        view.on_update(0.2)
        if view.game.phase == "awaiting-action" and view.is_human_turn:
            break

    round_before = view.game.round
    alive_before = view.game.count_alive()

    # Exit offers Save & exit; saving returns to the menu without losing the game.
    view._open_exit()
    assert view.confirm_exit
    assert app.paused
    view._save_exit()
    assert isinstance(app.current_view, views.MenuView)
    saved = app.state.saved_meta()
    assert len(saved) == 1
    assert saved[0]["map_preset"] == "Europe"

    # The resume panel rebuilds the exact game.
    app.show_panel("resume")
    panel = app.current_view
    panel._resume_saved(saved[0]["id"])
    resumed = app.current_view
    assert isinstance(resumed, views.GameView)
    assert resumed.game.round == round_before
    assert resumed.game.count_alive() == alive_before
    assert len(resumed.game.players) == 4
    assert resumed.game.config.map_preset == "Europe"
    # The saved entry is consumed once resumed.
    assert app.state.saved_meta() == []


def test_leave_game_requires_confirmation(app):
    app.show_setup()
    app.current_view._set_map("Europe")
    app.current_view._start()
    view = app.current_view
    assert isinstance(view, views.GameView)

    view._open_exit()
    view._leave_exit()  # first press asks for confirmation
    assert view.leave_confirm
    assert isinstance(app.current_view, views.GameView)
    view._leave_exit()  # second press actually leaves
    assert isinstance(app.current_view, views.MenuView)
    assert app.state.saved_meta() == []


def test_fog_of_war_never_draws_an_unclaimed_country_name(app):
    """Whatever is on screen, a country the player has not claimed is never named."""
    import arcade

    from gpd_desktop import mapdata as geo
    from gpd_desktop import views

    app.show_setup()
    setup = app.current_view
    setup._set_mode("offline-solo")
    setup._set_map("Europe")
    setup._set_players(4)
    setup._set_fog(True)
    setup._set_seed("2026")
    setup._start()

    view = app.current_view
    assert isinstance(view, views.GameView)
    view._click_country("FRA")
    view.game.players[0].money = 5000
    view.game.territories["FRA"].troops = 4
    # Someone else takes a country the viewer does not own.
    rival = view.game.players[1]
    view.game._log("claim", rival.id, f"{rival.name} claims {geo.BY_ID['DEU'].name}", territory="DEU")

    hidden = views.hidden_country_names(view.game, view._viewer())
    assert "Germany" in hidden and "France" not in hidden

    view._set_error("Germany does not border France.")
    arcade.calls.clear()
    view.on_draw()

    drawn = " ".join(str(call[1]) for call in arcade.calls if call[0] == "draw_text")
    for name in hidden:
        assert name not in drawn, f"{name!r} leaked into the UI"
    assert views.HIDDEN_NAME in drawn
    assert "France" in drawn


def test_fog_of_war_reveals_the_names_it_should(app):
    """With the modifier off nothing is redacted."""
    from gpd_desktop import views

    app.show_setup()
    setup = app.current_view
    setup._set_mode("offline-solo")
    setup._set_map("Europe")
    setup._set_players(4)
    setup._set_seed("2026")
    setup._start()
    view = app.current_view
    assert isinstance(view, views.GameView)
    assert views.hidden_country_names(view.game, view._viewer()) == {}


def test_atlas_shapes_map_to_distinct_countries():
    """Regression: Kosovo, N. Cyprus and Somaliland share the numeric id -99 in world-atlas.

    They used to collapse onto one record, so two territories rendered as a third (and the web
    client hit duplicate React keys). Each shape must own its own country id.
    """
    from gpd_desktop.render import WorldMapRender

    render = WorldMapRender("World")
    assert len(render.polygons) == len(set(render.polygons)), "two shapes share one country id"
    for cid in ("XKX", "XNC", "XSL"):
        assert render.polygons.get(cid), f"{cid} did not render at all"


def test_country_data_has_no_junk_numeric_codes():
    from gpd_desktop import mapdata

    codes = [c.n for c in mapdata.ALL_COUNTRIES]
    assert "undefined" not in codes and "null" not in codes
    real = [c for c in codes if c]
    assert len(real) == len(set(real)), "duplicate numeric codes in countries.json"
