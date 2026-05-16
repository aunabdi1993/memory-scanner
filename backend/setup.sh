#!/usr/bin/env bash
# Memories Scanner backend setup. Installs the system Tesseract binary
# (macOS via Homebrew, Linux via apt-get), creates a Python venv, and
# installs Python dependencies.

set -euo pipefail

cd "$(dirname "$0")"

# 1. Tesseract OCR binary
if command -v tesseract >/dev/null 2>&1; then
    echo "[setup] tesseract already installed: $(tesseract --version | head -1)"
else
    case "$(uname -s)" in
        Darwin)
            if ! command -v brew >/dev/null 2>&1; then
                echo "[setup] Homebrew not found. Install from https://brew.sh first." >&2
                exit 1
            fi
            echo "[setup] Installing tesseract via Homebrew..."
            brew install tesseract
            ;;
        Linux)
            echo "[setup] Installing tesseract via apt-get (sudo required)..."
            sudo apt-get update
            sudo apt-get install -y tesseract-ocr
            ;;
        *)
            echo "[setup] Unsupported OS: $(uname -s). Install tesseract manually." >&2
            exit 1
            ;;
    esac
fi

# 2. Python venv
if [ ! -d venv ]; then
    echo "[setup] Creating Python venv..."
    python3 -m venv venv
fi

# 3. Python dependencies
echo "[setup] Installing Python dependencies..."
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# 4. Runtime dirs
mkdir -p uploads processed

echo "[setup] Done. Activate with: source venv/bin/activate"
