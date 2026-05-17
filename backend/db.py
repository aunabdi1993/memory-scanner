"""SQLAlchemy engine and session factory.

We use SQLite by default because the only thing we persist is a small
table of Apple-authenticated users (one row each). Override
``DATABASE_URL`` for Postgres in production.
"""

from __future__ import annotations

import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./memories.db")

# check_same_thread=False is required for SQLite under FastAPI's
# threadpool model. Postgres doesn't need it.
engine_kwargs: dict = {}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass
