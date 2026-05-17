.PHONY: install backend app lint test clean

install:
	./backend/setup.sh
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

clean:
	rm -rf backend/venv backend/uploads backend/processed
	rm -rf app/node_modules app/.expo
