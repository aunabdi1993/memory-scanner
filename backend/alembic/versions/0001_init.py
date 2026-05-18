"""init: users + billing tables

Revision ID: 0001
Revises:
Create Date: 2026-05-17

Single revision creating the full current schema (users with billing
columns, subscriptions, usage_log + composite index). The stop-gap
ALTER block in db.py:_apply_user_billing_columns is replaced by this
revision — Alembic is now the source of truth.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(length=255), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "lifetime_scans",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "subscription_status",
            sa.String(length=16),
            nullable=False,
            server_default="free",
        ),
        sa.Column(
            "subscription_expires_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "apple_original_transaction_id",
            sa.String(length=64),
            nullable=True,
        ),
        sa.Column(
            "has_lifetime",
            sa.Boolean(),
            nullable=False,
            server_default="0",
        ),
    )
    op.create_index(
        "ix_users_apple_original_transaction_id",
        "users",
        ["apple_original_transaction_id"],
    )

    op.create_table(
        "subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.String(length=255),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "original_transaction_id",
            sa.String(length=64),
            nullable=False,
            unique=True,
        ),
        sa.Column("product_id", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "expires_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.Column(
            "environment",
            sa.String(length=16),
            nullable=False,
            server_default="sandbox",
        ),
        sa.Column(
            "last_notification_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column("raw_payload_json", sa.Text(), nullable=True),
    )
    op.create_index("ix_subscriptions_user_id", "subscriptions", ["user_id"])

    op.create_table(
        "usage_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "user_id",
            sa.String(length=255),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("photo_id", sa.String(length=64), nullable=True),
        sa.Column(
            "kind",
            sa.String(length=16),
            nullable=False,
            server_default="scan",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "counted",
            sa.Boolean(),
            nullable=False,
            server_default="1",
        ),
    )
    op.create_index("ix_usage_log_user_id", "usage_log", ["user_id"])
    op.create_index(
        "ix_usage_log_user_created", "usage_log", ["user_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_usage_log_user_created", table_name="usage_log")
    op.drop_index("ix_usage_log_user_id", table_name="usage_log")
    op.drop_table("usage_log")
    op.drop_index("ix_subscriptions_user_id", table_name="subscriptions")
    op.drop_table("subscriptions")
    op.drop_index(
        "ix_users_apple_original_transaction_id", table_name="users"
    )
    op.drop_table("users")
