FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Tesseract for OCR; libgl1 + libglib2.0 for opencv-python-headless.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        libgl1 \
        libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

RUN useradd --create-home --uid 1000 app \
 && mkdir -p /data/uploads /data/processed \
 && chown -R app:app /app /data
USER app

ENV UPLOADS_DIR=/data/uploads \
    PROCESSED_DIR=/data/processed \
    DATABASE_URL=sqlite:////data/memories.db

EXPOSE 8000

CMD ["gunicorn", \
     "-k", "uvicorn.workers.UvicornWorker", \
     "-w", "2", \
     "--timeout", "60", \
     "--bind", "0.0.0.0:8000", \
     "main:app"]
