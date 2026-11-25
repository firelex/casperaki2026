"""Puts the vocals service directory on sys.path so tests import `pipeline.*` as the adapter does."""
import sys
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))
