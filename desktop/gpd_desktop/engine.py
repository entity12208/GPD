"""The GPD rules engine (desktop client).

This is a faithful port of the TypeScript engine used by the web client:
same rules, same costs, same scoring, and the same seeded PRNG so a seed
reproduces the same game on both clients.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field, replace
from typing import Dict, List, Optional, Sequence

from . import mapdata as geo
from .rng import RNG

PLAYER_COLORS = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#00b8b8",
    "#f032e6", "#bfef45", "#fabebe", "#469990", "#9a6324", "#800000",
]

DEFAULT_NAMES = [
    "Red", "Green", "Blue", "Orange", "Purple", "Teal",
    "Magenta", "Lime", "Pink", "Mint", "Brown", "Maroon",
]

EXPAND_BASE = 100
SEA_EXTRA = 100
OCEAN_PER_TROOP = 50
TROOP_COST = 50
STARTING_MONEY = 500
ATTRITION = 0.1

TIMER_SECONDS = {"none": None, "1d": 86400, "10min": 600, "5min": 300, "1min": 60}

SCORE_KEYS = (
    "claim_unoccupied", "lose_country", "claim_occupied", "fail_to_win",
    "claim_continent", "win_game", "lose_game",
)


@dataclass
class ScoringRules:
    claim_unoccupied: int = 50
    lose_country: int = -50
    claim_occupied: int = 75
    fail_to_win: int = -20
    claim_continent: int = 200
    win_game: int = 500
    lose_game: int = -200

    def value(self, key: str) -> int:
        return int(getattr(self, key, 0))


DEFAULT_SCORING = ScoringRules()

# The rulebook's two presets. Players never edit rules or point values; the host
# only chooses the map, the seats and (for online games) the modifiers.
PRESETS = {
    "classic": {
        "id": "classic", "label": "Classic",
        "blurb": "1 player per team, up to 12 teams. Global and team chat. Every timer available.",
        "chat": "global+team",
        "timers": ["none", "1d", "10min", "5min", "1min"],
        "max_per_team": 1, "max_teams": 12,
        "min_players": 2,
    },
    "tournament": {
        "id": "tournament", "label": "Tournament",
        "blurb": "Up to 3 players per team, 4 teams. Team chat only. Daily, Rapid and Blitz timers.",
        "chat": "team",
        "timers": ["1d", "10min", "5min"],
        "max_per_team": 3, "max_teams": 4,
        # A team of three needs an equally sized opponent, so six players is the
        # smallest tournament that is actually a fair game.
        "min_players": 6,
    },
}
DEFAULT_PRESET = "classic"


def preset_capacity(preset: str) -> int:
    spec = PRESETS.get(preset, PRESETS[DEFAULT_PRESET])
    return int(spec["max_teams"]) * int(spec["max_per_team"])


def timer_allowed(preset: str, timer: str) -> bool:
    spec = PRESETS.get(preset, PRESETS[DEFAULT_PRESET])
    return timer in spec["timers"]


def min_players(preset: str) -> int:
    return int(PRESETS.get(preset, PRESETS[DEFAULT_PRESET])["min_players"])


def team_count_for(preset: str, players: int) -> int:
    spec = PRESETS.get(preset, PRESETS[DEFAULT_PRESET])
    if int(spec["max_per_team"]) <= 1:
        return max(1, players)
    return max(1, min(int(spec["max_teams"]), -(-max(1, players) // int(spec["max_per_team"]))))


def team_for(preset: str, index: int, players: int) -> int:
    """Balanced team index: sizes differ by at most one and never exceed max_per_team."""
    spec = PRESETS.get(preset, PRESETS[DEFAULT_PRESET])
    if int(spec["max_per_team"]) <= 1:
        return index % max(1, int(spec["max_teams"]))
    return index % team_count_for(preset, players)


@dataclass
class GameConfig:
    map_preset: str = "World"
    mode: str = "offline-solo"
    preset: str = DEFAULT_PRESET
    timer: str = "none"
    fog_of_war: bool = False
    blindfold: bool = False
    tournament: bool = False
    seed: Optional[int] = None
    human_players: int = 1
    player_count: Optional[int] = None
    scoring: ScoringRules = field(default_factory=ScoringRules)


@dataclass
class Territory:
    id: str
    owner: Optional[int] = None
    troops: int = 0
    vulnerable: bool = False
    ever_occupied: bool = False


@dataclass
class Stats:
    claimed: int = 0
    lost: int = 0
    won: int = 0
    failed: int = 0
    continents: int = 0


@dataclass
class Player:
    id: int
    name: str
    color: str
    team: int
    is_bot: bool
    alive: bool = True
    money: int = STARTING_MONEY
    score: int = 0
    score_raw: int = 0
    pending_peace: bool = False
    continents: List[str] = field(default_factory=list)
    stats: Stats = field(default_factory=Stats)


@dataclass
class ScoreEvent:
    player: int
    key: str


@dataclass
class GameEvent:
    round: int
    type: str
    player: Optional[int]
    text: str
    territory: Optional[str] = None
    from_: Optional[str] = None
    to: Optional[str] = None
    amount: int = 0
    troops: int = 0
    marker_teams: List[int] = field(default_factory=list)


@dataclass
class ExpandQuote:
    from_: str
    to: str
    water: Optional[str]
    km: int
    base: int
    water_fee: int
    ocean_fee: int
    total: int
    max_troops: int


def normalize_name(s: str) -> str:
    keep = [ch for ch in s.lower() if ch.isalnum()]
    return "".join(keep)


def score_multiplier(cfg: GameConfig) -> float:
    if cfg.blindfold:
        return 2.0
    if cfg.fog_of_war:
        return 1.5
    return 1.0


class GPDGame:
    """Turn-based game state machine implementing the GPD rulebook."""

    def __init__(self, config: Optional[GameConfig] = None, names: Optional[Sequence[str]] = None) -> None:
        cfg = config or GameConfig()
        # The preset is the single source of truth for teams.
        preset = cfg.preset or ("tournament" if cfg.tournament else DEFAULT_PRESET)
        cfg = replace(cfg, preset=preset, tournament=(preset == "tournament"))
        self.config = cfg
        seed = self.config.seed if self.config.seed is not None else int(time.time() * 1000) % (2**31)
        self.rng = RNG(seed)
        self._create_state(names)

    # ---------------------------------------------------------------- setup --
    def _create_state(self, names: Optional[Sequence[str]]) -> None:
        cfg = self.config
        active = [c.id for c in geo.countries_for_preset(cfg.map_preset)]
        self.active: List[str] = active
        self.territories: Dict[str, Territory] = {cid: Territory(cid) for cid in active}
        self.graph = geo.graph_for_preset(cfg.map_preset)

        n = max(1, min(12, cfg.player_count if cfg.player_count is not None else cfg.human_players))
        self.players: List[Player] = []
        for i in range(n):
            name = names[i] if names and i < len(names) else DEFAULT_NAMES[i % len(DEFAULT_NAMES)]
            self.players.append(
                Player(
                    id=i,
                    name=name,
                    color=PLAYER_COLORS[i % len(PLAYER_COLORS)],
                    team=team_for(cfg.preset, i, n),
                    is_bot=i >= cfg.human_players or cfg.mode == "offline-sim",
                )
            )
        if cfg.mode == "offline-sim":
            for p in self.players:
                p.is_bot = True
        if cfg.mode == "offline-solo":
            for p in self.players:
                p.is_bot = p.id != 0

        self.turn_order = self._build_turn_order()
        self.turn = 0
        self.round = 1
        self.phase = "placement"
        self.placement_queue = list(self.turn_order)
        self.gather_cap = 0
        self.pending_type: Optional[str] = None
        self.turn_deadline: Optional[float] = None
        self.log: List[GameEvent] = []
        self.markers: List[dict] = []
        self.score_events: List[ScoreEvent] = []
        self.winner: Optional[int] = None
        self.winning_team: Optional[int] = None

    def _build_turn_order(self) -> List[int]:
        if not self.config.tournament:
            return [p.id for p in self.players]
        by_team: Dict[int, List[int]] = {}
        for p in self.players:
            by_team.setdefault(p.team, []).append(p.id)
        order: List[int] = []
        size = max(len(v) for v in by_team.values())
        for i in range(size):
            for team in sorted(by_team):
                if i < len(by_team[team]):
                    order.append(by_team[team][i])
        return order

    # ------------------------------------------------------------- actors ----
    @property
    def current_player(self) -> Optional[Player]:
        if self.phase == "finished" or self.placement_queue:
            return None
        return self.players[self.turn_order[self.turn % len(self.turn_order)]]

    @property
    def actor(self) -> Optional[Player]:
        if self.phase == "placement":
            if not self.placement_queue:
                return None
            return self.players[self.placement_queue[0]]
        return self.current_player

    def eligible_actors(self) -> List[Player]:
        """Everyone allowed to submit the current move.

        In Tournament mode the turn belongs to a team, so any living member of the
        acting player's team may move for it; Classic hands each player their own turn.
        """
        a = self.actor
        if a is None:
            return []
        if not self.config.tournament:
            return [a]
        return [p for p in self.players if p.alive and p.team == a.team]

    def can_act(self, player_id: int) -> bool:
        return any(p.id == player_id for p in self.eligible_actors())

    def can_see_name(self, player_id: int, country_id: str) -> bool:
        """Under Fog of War and Blindfold a player only learns names they own."""
        if not (self.config.fog_of_war or self.config.blindfold):
            return True
        territory = self.territories.get(country_id)
        return territory is not None and territory.owner == player_id

    # ---------------------------------------------------------- placement ----
    def place_starting_country(self, player_id: int, country_id: str):
        if self.phase != "placement":
            return False, "Placement is over"
        if not self.placement_queue or self.placement_queue[0] != player_id:
            return False, "Not your pick"
        t = self.territories.get(country_id)
        if t is None:
            return False, "Unknown country"
        if t.owner is not None:
            return False, "Country already taken"
        t.owner = player_id
        t.troops = 1
        t.ever_occupied = True
        self.placement_queue.pop(0)
        self._log("turn", player_id, f"{self.players[player_id].name} starts in {geo.BY_ID[country_id].name}",
                  territory=country_id)
        if not self.placement_queue:
            self.phase = "awaiting-action"
            self.turn = 0
            self.round = 1
            self._begin_turn()
        return True, None

    def auto_place(self, player_id: int) -> Optional[str]:
        free = [cid for cid in self.active if self.territories[cid].owner is None]
        if not free:
            return None
        cid = self.rng.choice(free)
        ok, _ = self.place_starting_country(player_id, cid)
        return cid if ok else None

    # --------------------------------------------------------------- turns ---
    def _begin_turn(self) -> None:
        p = self.current_player
        if p is None:
            return
        if not p.alive:
            self.turn = self._next_turn_index()
            self._begin_turn()
            return
        if p.pending_peace:
            owned = self.owned_by(p.id)
            income = 100 * len(owned)
            for cont in self.full_continents(p.id):
                income += 10 * self.continent_size(cont)
            p.money += income
            p.pending_peace = False
            self._log("income", p.id, f"{p.name} collects ${income} from Peace", amount=income)
        for t in self.territories.values():
            if t.owner == p.id and t.vulnerable:
                t.vulnerable = False
        self.phase = "awaiting-action"
        self.pending_type = None
        self.gather_cap = 0
        secs = TIMER_SECONDS[self.config.timer]
        self.turn_deadline = None if secs is None else time.time() + secs
        self._log("turn", p.id, f"{p.name}'s turn")

    def _next_turn_index(self) -> int:
        order = self.turn_order
        n = len(order)
        idx = self.turn
        for k in range(1, n + 1):
            nxt = (idx + k) % n
            if self.players[order[nxt]].alive:
                if nxt <= idx:
                    self.round += 1
                return nxt
        return idx

    def end_turn(self) -> None:
        if self.phase == "finished":
            return
        self.turn_deadline = None
        if self.check_win():
            return
        self.turn = self._next_turn_index()
        self._begin_turn()

    def tick(self, now: Optional[float] = None) -> bool:
        if self.turn_deadline is None or self.phase in ("finished", "placement"):
            return False
        now = time.time() if now is None else now
        if now < self.turn_deadline:
            return False
        p = self.current_player
        if p is None:
            return False
        self.timeout(p.id)
        return True

    def timeout(self, player_id: int) -> None:
        p = self.players[player_id]
        for t in self.owned_by(player_id):
            t.owner = None
            t.troops = 0
            t.vulnerable = False
        p.alive = False
        self._log("timeout", player_id, f"{p.name} ran out of time and was removed from the game")
        self.award(player_id, "lose_game")
        if not self.check_win():
            self.turn_deadline = None
            self.end_turn()

    # ------------------------------------------------------------ actions ----
    def available_actions(self) -> List[str]:
        return ["peace", "gather", "expand", "nothing"] if self.actor else []

    def choose_action(self, action: str):
        p = self.actor
        if p is None:
            return False, "No active player"
        if self.phase != "awaiting-action":
            return False, "Not accepting actions"
        if self.pending_type and self.pending_type != action:
            return False, "Finish the current action"
        if action == "gather":
            self.gather_cap = self.rng.int(1, 20)
            self.phase = "gather-distribution"
            self.pending_type = "gather"
            self._log("gather", p.id, f"{p.name} may buy up to {self.gather_cap} troops", troops=self.gather_cap)
            return True, None
        if action == "peace":
            self.pending_type = "peace"
            return True, None
        if action == "expand":
            self.pending_type = "expand"
            return True, None
        return self.submit_nothing()

    def submit_nothing(self):
        p = self.actor
        if p is None:
            return False, "No active player"
        if self.phase != "awaiting-action":
            return False, "Not accepting actions"
        self._log("turn", p.id, f"{p.name} does nothing")
        self.pending_type = None
        self.end_turn()
        return True, None

    def can_peace(self, player_id: int, territory_id: str) -> bool:
        t = self.territories.get(territory_id)
        return bool(t and t.owner == player_id)

    def submit_peace(self, territory_id: str):
        p = self.actor
        if p is None:
            return False, "No active player"
        if self.pending_type != "peace" and self.phase != "awaiting-action":
            return False, "Not choosing Peace"
        t = self.territories.get(territory_id)
        if t is None or t.owner != p.id:
            return False, "You do not own that country"
        t.vulnerable = True
        p.pending_peace = True
        self._log("peace", p.id, f"{p.name} declares Peace in {geo.BY_ID[territory_id].name} — vulnerable until their next turn",
                  territory=territory_id, marker_teams=[p.team])
        self.pending_type = None
        self.end_turn()
        return True, None

    def submit_gather(self, distribution: Dict[str, int]):
        p = self.actor
        if p is None:
            return False, "No active player"
        if self.phase != "gather-distribution":
            return False, "Not gathering troops"
        total = 0
        for cid, n in distribution.items():
            if not isinstance(n, int) or n < 0:
                return False, "Invalid troop count"
            t = self.territories.get(cid)
            if t is None or t.owner != p.id:
                return False, f"You do not own {geo.BY_ID[cid].name if cid in geo.BY_ID else cid}"
            total += n
        if total < 1:
            return False, "Buy at least 1 troop"
        if total > self.gather_cap:
            return False, f"At most {self.gather_cap} troops this turn"
        cost = total * TROOP_COST
        if cost > p.money:
            return False, f"Not enough money (need ${cost})"
        p.money -= cost
        for cid, n in distribution.items():
            if n > 0:
                self.territories[cid].troops += n
        self._log("gather", p.id, f"{p.name} gathered {total} troops for ${cost}", troops=total, amount=cost)
        self.pending_type = None
        self.phase = "awaiting-action"
        self.end_turn()
        return True, None

    def quote_expand(self, player_id: int, src: str, dst: str, troops: int):
        t = self.territories.get(src)
        d = self.territories.get(dst)
        if t is None or d is None:
            return "Unknown country"
        if t.owner != player_id:
            return "You do not own the origin country"
        if src == dst:
            return "Pick a different country"
        if d.owner == player_id:
            return "You already own that country"
        if (d.owner is not None and self.config.tournament
                and self.players[d.owner].team == self.players[player_id].team):
            return "That country belongs to an ally"
        lane = self.graph.lane(src, dst)
        if lane is None:
            return (f"{geo.BY_ID[dst].name} does not border {geo.BY_ID[src].name} — "
                    "you cannot expand through other countries")
        max_troops = max(0, t.troops - 1)
        if troops < 1:
            return "Send at least 1 troop"
        if troops > max_troops:
            return f"You may send at most {max_troops} troops"
        water_fee = SEA_EXTRA if lane.water == "sea" else 0
        ocean_fee = OCEAN_PER_TROOP * troops if lane.water == "ocean" else 0
        return ExpandQuote(
            from_=src, to=dst, water=lane.water, km=lane.km, base=EXPAND_BASE,
            water_fee=water_fee, ocean_fee=ocean_fee,
            total=EXPAND_BASE + water_fee + ocean_fee, max_troops=max_troops,
        )

    def submit_expand(self, src: str, dst: str, troops: int, typed: Optional[str] = None):
        p = self.actor
        if p is None:
            return False, "No active player"
        if self.phase != "awaiting-action":
            return False, "Not accepting actions"

        # A name the player was never shown cannot be misspelled, so under the
        # modifiers the order only has to be issued.
        if typed is not None and self.can_see_name(p.id, dst):
            target = geo.BY_ID.get(dst)
            if normalize_name(typed) != normalize_name(target.name if target else ""):
                self._log("forfeit", p.id, f'{p.name} mis-spelled "{typed}" and loses the turn')
                self.pending_type = None
                self.end_turn()
                return False, "Mis-spelled country name — turn lost"

        quote = self.quote_expand(p.id, src, dst, troops)
        if isinstance(quote, str):
            return False, quote
        if quote.total > p.money:
            return False, f"Not enough money (need ${quote.total})"

        source = self.territories[src]
        target = self.territories[dst]
        p.money -= quote.total
        source.troops -= troops

        arriving = troops
        if quote.water is not None:
            lost = sum(1 for _ in range(troops) if self.rng.next() < ATTRITION)
            arriving = troops - lost
            if lost:
                kind = "water" if quote.water == "sea" else "ocean"
                self._log("expand", p.id,
                          f"{lost} of {troops} troops were lost crossing the {kind}",
                          from_=src, to=dst, troops=lost)

        self._log("expand", p.id,
                  f"{p.name} expands from {geo.BY_ID[src].name} into {geo.BY_ID[dst].name} "
                  f"with {troops} troops (${quote.total})",
                  from_=src, to=dst, troops=troops, amount=quote.total, marker_teams=[p.team])

        if target.owner is None:
            self._claim(p.id, dst, arriving, target.ever_occupied)
            self.pending_type = None
            self.end_turn()
            return True, None

        defender = self.players[target.owner]
        if target.vulnerable:
            self._log("combat", p.id,
                      f"{geo.BY_ID[dst].name} was vulnerable — {defender.name}'s garrison is wiped out",
                      territory=dst, marker_teams=[defender.team, p.team])
            self._lose_country(defender.id, dst)
            self._claim(p.id, dst, arriving, True)
            self.pending_type = None
            self.end_turn()
            return True, None

        atk = sum(self.rng.int(1, 20) for _ in range(arriving))
        dfn = sum(self.rng.int(1, 20) for _ in range(target.troops))
        self._log("combat", p.id,
                  f"Battle for {geo.BY_ID[dst].name}: {p.name} rolls {atk} ({arriving} troops) "
                  f"vs {defender.name} {dfn} ({target.troops} troops)",
                  territory=dst, marker_teams=[p.team, defender.team])
        if atk > dfn:
            self._lose_country(defender.id, dst)
            self._claim(p.id, dst, max(arriving, 0), True)
            self._log("combat", p.id, f"{p.name} takes {geo.BY_ID[dst].name}",
                      territory=dst, marker_teams=[p.team, defender.team])
        else:
            self.award(p.id, "fail_to_win")
            self.players[p.id].stats.failed += 1
            self._log("combat", p.id,
                      f"{defender.name} holds {geo.BY_ID[dst].name}; all attacking troops die",
                      territory=dst, marker_teams=[p.team, defender.team])
        self.pending_type = None
        self.end_turn()
        return True, None

    # ----------------------------------------------------------- internals ---
    def _claim(self, player_id: int, cid: str, troops: int, was_occupied: bool) -> None:
        t = self.territories[cid]
        t.owner = player_id
        t.troops = troops if was_occupied else max(troops, 1)
        t.vulnerable = False
        t.ever_occupied = True
        p = self.players[player_id]
        p.stats.claimed += 1
        self.award(player_id, "claim_occupied" if was_occupied else "claim_unoccupied")
        self._log("claim", player_id, f"{p.name} claims {geo.BY_ID[cid].name}",
                  territory=cid, marker_teams=[p.team])
        self.sync_continents(player_id)

    def _lose_country(self, player_id: int, cid: str) -> None:
        t = self.territories[cid]
        if t.owner is None:
            return
        p = self.players[player_id]
        p.stats.lost += 1
        self.award(player_id, "lose_country")
        self._log("loss", player_id, f"{p.name} loses {geo.BY_ID[cid].name}",
                  territory=cid, marker_teams=[p.team])
        t.owner = None
        t.troops = 0
        t.vulnerable = False
        self.sync_continents(player_id)
        self.check_elimination(player_id)

    def check_elimination(self, player_id: int) -> None:
        if self.phase == "placement":
            return
        p = self.players[player_id]
        if not p.alive or self.owned_by(player_id):
            return
        p.alive = False
        self._log("eliminated", player_id, f"{p.name} has been eliminated")

    # ------------------------------------------------------------- scoring ---
    def award(self, player_id: int, key: str) -> None:
        self.score_events.append(ScoreEvent(player_id, key))
        p = self.players[player_id]
        p.score_raw += self.config.scoring.value(key)
        p.score = int(round(p.score_raw * score_multiplier(self.config)))

    def recalculate(self, rules: Optional[ScoringRules] = None) -> None:
        """Rebuild every total from the recorded events (different rule sets allowed)."""
        if rules is not None:
            self.config.scoring = rules
        m = score_multiplier(self.config)
        for p in self.players:
            p.score_raw = sum(self.config.scoring.value(e.key) for e in self.score_events if e.player == p.id)
            p.score = int(round(p.score_raw * m))

    def calculate_score(self, player_id: int, rules: Optional[ScoringRules] = None, multiplier: float = 1.0) -> int:
        rules = rules or self.config.scoring
        total = sum(rules.value(e.key) for e in self.score_events if e.player == player_id)
        return int(round(total * multiplier))

    # ------------------------------------------------------------- geography -
    def owned_by(self, player_id: int) -> List[Territory]:
        return [t for t in self.territories.values() if t.owner == player_id]

    def continent_size(self, cont: str) -> int:
        active = set(self.active)
        return sum(1 for c in geo.continent_members(cont) if c.id in active)

    def _active_continents(self) -> List[str]:
        seen: List[str] = []
        for cid in self.active:
            cont = geo.BY_ID[cid].cont
            if cont not in seen:
                seen.append(cont)
        return seen

    def full_continents(self, player_id: int) -> List[str]:
        out: List[str] = []
        for cont in self._active_continents():
            members = [c for c in geo.continent_members(cont) if c.id in self.territories]
            if members and all(self.territories[c.id].owner == player_id for c in members):
                out.append(cont)
        return out

    def sync_continents(self, player_id: int) -> None:
        p = self.players[player_id]
        now = set(self.full_continents(player_id))
        for cont in now:
            if cont not in p.continents:
                p.continents.append(cont)
                p.stats.continents += 1
                self.award(player_id, "claim_continent")
                self._log("continent", player_id,
                          f"{p.name} controls all of {cont} (+{10 * self.continent_size(cont)}/turn)",
                          amount=10 * self.continent_size(cont))
        p.continents = [c for c in p.continents if c in now]

    # ------------------------------------------------------------- endings ---
    def team_alive(self, team: int) -> bool:
        return any(p.team == team and p.alive for p in self.players)

    def check_win(self) -> bool:
        if self.phase == "finished":
            return True
        alive_teams = [t for t in dict.fromkeys(p.team for p in self.players) if self.team_alive(t)]
        alive_players = [p for p in self.players if p.alive]
        over = (len(alive_teams) <= 1) if self.config.tournament else (len(alive_players) <= 1)
        if not over:
            return False
        self.phase = "finished"
        self.turn_deadline = None
        if self.config.tournament:
            self.winning_team = alive_teams[0] if alive_teams else None
            winner = next((p.id for p in self.players if p.team == self.winning_team and p.alive), None)
        else:
            self.winning_team = alive_players[0].team if alive_players else None
            winner = alive_players[0].id if alive_players else None
        self.winner = winner
        for p in self.players:
            if self.winning_team is not None and p.team == self.winning_team and p.alive:
                self.score_events.append(ScoreEvent(p.id, "win_game"))
            else:
                self.score_events.append(ScoreEvent(p.id, "lose_game"))
        self.recalculate()
        winners = " & ".join(p.name for p in self.players if self.winning_team is not None and p.team == self.winning_team)
        self._log("win", winner, f"{winners or 'nobody'} wins the game!")
        return True

    def count_alive(self) -> int:
        return sum(1 for p in self.players if p.alive)

    # ------------------------------------------------------------ serialisation
    def to_dict(self) -> dict:
        """A full snapshot, including the PRNG state, so a game can be resumed."""
        return {
            "config": asdict(self.config),
            "players": [asdict(p) for p in self.players],
            "territories": {cid: asdict(t) for cid, t in self.territories.items()},
            "active": list(self.active),
            "turn": self.turn,
            "turn_order": list(self.turn_order),
            "round": self.round,
            "phase": self.phase,
            "gather_cap": self.gather_cap,
            "pending_type": self.pending_type,
            "log": [asdict(e) for e in self.log],
            "markers": [dict(m) for m in self.markers],
            "score_events": [asdict(e) for e in self.score_events],
            "winner": self.winner,
            "winning_team": self.winning_team,
            "placement_queue": list(self.placement_queue),
            "rng": self.rng.s,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "GPDGame":
        game = cls.__new__(cls)
        cfg = data["config"]
        scoring = cfg.get("scoring") or {}
        defaults = ScoringRules()
        game.config = GameConfig(
            map_preset=cfg.get("map_preset", "World"),
            mode=cfg.get("mode", "offline-solo"),
            preset=cfg.get("preset", DEFAULT_PRESET),
            timer=cfg.get("timer", "none"),
            fog_of_war=cfg.get("fog_of_war", False),
            blindfold=cfg.get("blindfold", False),
            tournament=cfg.get("tournament", False),
            seed=cfg.get("seed"),
            human_players=cfg.get("human_players", 1),
            player_count=cfg.get("player_count"),
            scoring=ScoringRules(**{k: int(scoring.get(k, getattr(defaults, k))) for k in SCORE_KEYS}),
        )
        game.players = [
            Player(
                id=pd["id"], name=pd["name"], color=pd["color"], team=pd["team"],
                is_bot=pd["is_bot"], alive=pd.get("alive", True), money=pd.get("money", STARTING_MONEY),
                score=pd.get("score", 0), score_raw=pd.get("score_raw", 0),
                pending_peace=pd.get("pending_peace", False),
                continents=list(pd.get("continents", [])), stats=Stats(**pd.get("stats", {})),
            )
            for pd in data["players"]
        ]
        game.territories = {
            cid: Territory(
                id=td.get("id", cid), owner=td.get("owner"), troops=td.get("troops", 0),
                vulnerable=td.get("vulnerable", False), ever_occupied=td.get("ever_occupied", False),
            )
            for cid, td in data["territories"].items()
        }
        game.active = list(data["active"])
        game.graph = geo.graph_for_preset(game.config.map_preset)
        game.turn = data["turn"]
        game.turn_order = list(data["turn_order"])
        game.round = data["round"]
        game.phase = data["phase"]
        game.gather_cap = data["gather_cap"]
        game.pending_type = data.get("pending_type")
        game.log = [GameEvent(**e) for e in data.get("log", [])]
        game.markers = [dict(m) for m in data.get("markers", [])]
        game.score_events = [ScoreEvent(**e) for e in data.get("score_events", [])]
        game.winner = data.get("winner")
        game.winning_team = data.get("winning_team")
        game.placement_queue = list(data.get("placement_queue", []))
        game.rng = RNG(0)
        game.rng.s = int(data.get("rng", 0)) & 0xFFFFFFFF
        seconds = TIMER_SECONDS.get(game.config.timer)
        if game.phase in ("awaiting-action", "gather-distribution") and seconds:
            game.turn_deadline = time.time() + seconds
        else:
            game.turn_deadline = None
        return game

    # --------------------------------------------------------------- vision --
    def view_for(self, player_id: int) -> dict:
        visible = {}
        for cid in self.active:
            t = self.territories[cid]
            mine = t.owner == player_id
            if self.config.blindfold or (self.config.fog_of_war and not mine):
                visible[cid] = {"owner": None, "troops": None, "vulnerable": None}
            else:
                visible[cid] = {"owner": t.owner, "troops": t.troops, "vulnerable": t.vulnerable}
        my_team = self.players[player_id].team if player_id < len(self.players) else -1
        markers = [dict(m, is_mine=m["team"] == my_team) for m in self.markers if m["round"] >= self.round - 1]
        return {"visible": visible, "markers": markers}

    # ------------------------------------------------------------------ log --
    def _log(self, kind: str, player: Optional[int], text: str, **kw) -> None:
        ev = GameEvent(round=self.round, type=kind, player=player, text=text, **kw)
        self.log.append(ev)
        for team in ev.marker_teams:
            if ev.territory:
                self.markers.append({"territory": ev.territory, "team": team, "round": self.round})
        if len(self.log) > 4000:
            del self.log[:1000]
