"""Account-lock queue — one batch evaluation (or insights analysis) at a time.

AgentCore allows a single active batch evaluation per account, so concurrent
requests QUEUE instead of failing. Single worker thread; positions exposed
for the UI ("QUEUED · acct lock").
"""

import queue
import threading
from collections.abc import Callable
from typing import Any


class AccountLockQueue:
    def __init__(self) -> None:
        self._queue: queue.Queue[tuple[str, Callable[[], None]]] = queue.Queue()
        self._lock = threading.Lock()
        self._pending: list[str] = []
        self._running: str | None = None
        self._worker: threading.Thread | None = None

    def submit(self, run_id: str, fn: Callable[[], None]) -> int:
        """Enqueue a run; returns its queue position (0 = will run next/now)."""
        with self._lock:
            self._pending.append(run_id)
            position = len(self._pending) - 1 + (1 if self._running else 0)
        self._queue.put((run_id, fn))
        self._ensure_worker()
        return position

    def _ensure_worker(self) -> None:
        with self._lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(target=self._drain, daemon=True)
            self._worker.start()

    def _drain(self) -> None:
        while True:
            try:
                run_id, fn = self._queue.get(timeout=1.0)
            except queue.Empty:
                return
            with self._lock:
                if run_id in self._pending:
                    self._pending.remove(run_id)
                self._running = run_id
            try:
                fn()
            except Exception:
                pass  # run status carries the failure; the queue must survive
            finally:
                with self._lock:
                    self._running = None
                self._queue.task_done()

    def state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "running": self._running,
                "queued": list(self._pending),
                "locked": self._running is not None,
            }

    def position(self, run_id: str) -> int | None:
        with self._lock:
            if run_id == self._running:
                return 0
            if run_id in self._pending:
                return self._pending.index(run_id) + 1
        return None


account_lock = AccountLockQueue()
