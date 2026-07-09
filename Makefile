.PHONY: dev verify bootstrap backend frontend

dev:
	bash scripts/dev.sh

verify:
	bash scripts/verify.sh

bootstrap:
	cd backend && uv run python ../scripts/bootstrap.py

backend:
	cd backend && uv run uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev
