"""Bot opponents, mirroring the web client's AI so both clients play alike."""

from __future__ import annotations

import math
from typing import Optional

from . import mapdata as geo
from .engine import GPDGame, TROOP_COST, Territory

STYLES = ("aggressive", "balanced", "turtle", "balanced")


def style_for(player_id: int) -> str:
    return STYLES[player_id % len(STYLES)]


def neighbours(game: GPDGame, cid: str):
    return game.graph.adj.get(cid, [])


def is_enemy(game: GPDGame, owner: int, t: Territory) -> bool:
    if t is None or t.owner == owner:
        return False
    if t.owner is not None and game.config.tournament:
        if game.players[t.owner].team == game.players[owner].team:
            return False
    return True


def attack_targets(game: GPDGame, t: Territory) -> int:
    n = 0
    for lane in neighbours(game, t.id):
        other = game.territories.get(lane.id)
        if other is not None and is_enemy(game, t.owner, other):
            n += 1
    return n


class Candidate:
    __slots__ = ("src", "dst", "defenders", "edge", "value", "max_troops", "quote")

    def __init__(self, src, dst, defenders, edge, value, max_troops, quote):
        self.src = src
        self.dst = dst
        self.defenders = defenders
        self.edge = edge
        self.value = value
        self.max_troops = max_troops
        self.quote = quote


def _best_candidate(game: GPDGame, player) -> Optional[Candidate]:
    best: Optional[Candidate] = None
    for src in game.owned_by(player.id):
        if src.troops < 2:
            continue
        for lane in neighbours(game, src.id):
            dst = game.territories.get(lane.id)
            if dst is None or not is_enemy(game, player.id, dst):
                continue
            quote = game.quote_expand(player.id, src.id, dst.id, 1)
            if isinstance(quote, str) or quote.total > player.money:
                continue
            defenders = 0 if dst.vulnerable else dst.troops
            edge = src.troops - 1 - defenders
            value = 60.0 if dst.owner is None else 10.0
            if dst.vulnerable:
                value += 45
            value -= quote.total / 25
            if quote.water == "ocean":
                value -= 8
            elif quote.water == "sea":
                value -= 3
            cont = geo.BY_ID[dst.id].cont
            members = [cid for cid in game.active if geo.BY_ID[cid].cont == cont]
            mine = sum(1 for cid in members if game.territories[cid].owner == player.id)
            if mine == len(members) - 1:
                value += 70
            score = edge + value / 10
            if best is None or score > best.edge + best.value / 10:
                best = Candidate(src, dst, defenders, edge, value, quote.max_troops, quote)
    return best


def bot_act(game: GPDGame) -> bool:
    """Perform one action for the acting bot."""
    if game.phase == "finished":
        return False
    if game.phase == "placement":
        actor = game.actor
        if actor is None or not actor.is_bot:
            return False
        game.auto_place(actor.id)
        return True
    if game.phase == "gather-distribution":
        return bot_finish_gather(game)
    if game.phase != "awaiting-action":
        return False
    p = game.current_player
    if p is None or not p.is_bot:
        return False
    style = style_for(p.id)
    owned = game.owned_by(p.id)
    if not owned:
        game.submit_nothing()
        return True

    best = _best_candidate(game, p)
    if best is not None:
        advantage = best.src.troops - 1
        if best.defenders == 0:
            need = 0
        else:
            factor = max(1.0, 1.5 - game.round / 3000)
            bonus = 0 if style == "aggressive" else (1 if style == "balanced" else 3)
            need = math.ceil(best.defenders * factor) + bonus
        if advantage >= need and best.max_troops >= 1:
            send = best.max_troops if style == "aggressive" else math.ceil(best.max_troops * 0.7)
            send = max(1, min(best.max_troops, send))
            while send > 1:
                q = game.quote_expand(p.id, best.src.id, best.dst.id, send)
                if not isinstance(q, str) and q.total <= p.money:
                    break
                send -= 1
            q = game.quote_expand(p.id, best.src.id, best.dst.id, send)
            if not isinstance(q, str) and q.total <= p.money:
                game.submit_expand(best.src.id, best.dst.id, send)
                return True

    if p.money >= 250:
        game.choose_action("gather")
        return True
    if not p.pending_peace and owned:
        game.submit_peace(max(owned, key=lambda t: t.troops).id)
        return True
    if p.money >= TROOP_COST:
        game.choose_action("gather")
        return True
    game.submit_nothing()
    return True


def bot_finish_gather(game: GPDGame) -> bool:
    if game.phase != "gather-distribution":
        return False
    p = game.current_player
    if p is None or not p.is_bot:
        return False
    owned = game.owned_by(p.id)
    if not owned:
        game.submit_nothing()
        return True
    troops = max(1, min(game.gather_cap, p.money // TROOP_COST))
    front = sorted([t for t in owned if attack_targets(game, t) > 0],
                   key=lambda t: attack_targets(game, t), reverse=True)
    pool = front or owned
    dist = {}
    if len(pool) == 1:
        dist[pool[0].id] = troops
    else:
        anchor = math.ceil(troops * 0.7)
        dist[pool[0].id] = anchor
        left = troops - anchor
        for i in range(1, len(pool)):
            if left <= 0:
                break
            share = min(left, max(1, left // (len(pool) - i)))
            dist[pool[i].id] = share
            left -= share
        if left > 0:
            dist[pool[0].id] = dist.get(pool[0].id, 0) + left
    ok, _ = game.submit_gather(dist)
    return ok
