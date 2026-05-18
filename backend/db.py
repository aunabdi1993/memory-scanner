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

def init_db() -> None:
    """Create tables. Idempotent — safe to call on every startup."""
    # Importing here so all models register themselves with Base before
    # create_all runs.
    from models import Subscription, UsageLog, User  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _apply_user_billing_columns()


def _apply_user_billing_columns() -> None:
    """Stop-gap migration: add billing columns to a pre-existing ``users``
    table.

    ``create_all`` only creates missing tables, never adds missing
    columns. Until Alembic is wired in (see the Phasing section of the
    pricing plan), dev SQLite databases from earlier app versions need
    a one-shot ALTER. Idempotent — checked via PRAGMA / information_schema.
    """
    from sqlalchemy import inspect, text

    inspector = inspect(engine)
    if "users" not in inspector.get_table_names():
        return  # fresh DB, create_all already laid down the full schema

    existing = {col["name"] for col in inspector.get_columns("users")}
    pending = [
        ("lifetime_scans", "INTEGER NOT NULL DEFAULT 0"),
        ("subscription_status", "VARCHAR(16) NOT NULL DEFAULT 'free'"),
        ("subscription_expires_at", "TIMESTAMP NULL"),
        ("apple_original_transaction_id", "VARCHAR(64) NULL"),
        ("has_lifetime", "BOOLEAN NOT NULL DEFAULT 0"),
    ]
    with engine.begin() as conn:
        for name, ddl in pending:
            if name in existing:
                continue
            conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {ddl}"))
