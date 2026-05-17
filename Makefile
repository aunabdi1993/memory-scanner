.PHONY: install backend app lint test clean migrate migration docker-build docker-up docker-down

install:
	cd backend && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
	cd app && npm install

backend:
	cd backend && ./venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8000

app:
	cd app && npx expo start

lint:
	cd backend && ./venv/bin/flake8 .
	cd app && npx tsc --noEmit

test:
	cd backend && ./venv/bin/pytest tests/

migrate:
	cd backend && ./venv/bin/alembic upgrade head

# Usage: make migration name="add photos table"
migration:
	cd backend && ./venv/bin/alembic revision --autogenerate -m "$(name)"

docker-build:
	docker compose build

docker-up:
	docker compose up

docker-down:
	docker compose down

clean:
	rm -rf backend/venv backend/uploads backend/processed
	rm -rf app/node_modules app/.expo
