"""SQLAlchemy engine / session for the local ledger database."""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import DATA_DIR, get_settings


class Base(DeclarativeBase):
    pass


def _make_engine():
    settings = get_settings()
    if settings.database_url.startswith("sqlite"):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
    return create_engine(
        settings.database_url,
        connect_args=(
            {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
        ),
    )


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
