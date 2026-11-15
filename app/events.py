"""In-process SSE pub/sub for live leaderboard pushes.

Single-process only. If the app ever runs multiple workers, replace this with
Redis pub/sub (see ADR 0001, decision 3).
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator


class Broadcaster:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()

    async def subscribe(self) -> AsyncIterator[str]:
        q: asyncio.Queue[str] = asyncio.Queue()
        self._subscribers.add(q)
        try:
            while True:
                yield await q.get()
        finally:
            self._subscribers.discard(q)

    async def publish(self, event: str) -> None:
        for q in list(self._subscribers):
            q.put_nowait(event)


broadcaster = Broadcaster()
