"""Alle MuPDF-Aufrufe laufen über genau einen Arbeits-Thread.

PyMuPDF ist nicht threadsicher. Statt überall Sperren zu setzen, schicken wir
jede Operation an einen eigenen Executor mit einem Thread. Das hält den
asynchronen Webserver frei und verhindert Abstürze bei parallelen Anfragen.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, TypeVar

T = TypeVar("T")

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mupdf")


async def im_mupdf_thread(funktion: Callable[..., T], *args, **kwargs) -> T:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_executor, lambda: funktion(*args, **kwargs))


def im_mupdf_thread_sync(funktion: Callable[..., T], *args, **kwargs) -> T:
    """Synchrone Variante (für Tests und Start-Code außerhalb der Event-Loop)."""
    return _executor.submit(funktion, *args, **kwargs).result()
