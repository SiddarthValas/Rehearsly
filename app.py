"""Vercel entrypoint: Vercel looks for a FastAPI instance named `app` in app.py."""
from server.main import app  # noqa: F401
