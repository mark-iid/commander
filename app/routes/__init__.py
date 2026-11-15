"""Route modules, plus the shared Jinja environment and storage dependency.

These live here rather than in main.py so routers can import them without a cycle.
"""
from __future__ import annotations

import pathlib
from typing import Annotated

from fastapi import Depends
from fastapi.templating import Jinja2Templates

from app.assets import asset_url
from app.db import get_storage
from app.repository import Storage

TEMPLATE_DIR = pathlib.Path(__file__).resolve().parents[1] / "templates"

templates = Jinja2Templates(directory=str(TEMPLATE_DIR))

# Every <link> and <script> goes through this, so a deployed change reaches the
# projector instead of waiting out Cloudflare's four-hour edge cache.
templates.env.globals["asset"] = asset_url

StorageDep = Annotated[Storage, Depends(get_storage)]
