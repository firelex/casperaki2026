import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.fixture(scope="session")
def library():
    return json.loads((ROOT / "library.json").read_text())


@pytest.fixture
def design():
    """Mia from the 2026-11-28 test, as a design."""
    return {
        "body": {"gender": 0.0, "age": 26, "weight": 0.45, "muscle": 0.5, "proportions": 0.75},
        "ancestry": {"african": 0.0, "asian": 0.0, "european": 1.0},
        "face": {"jawWidth": 0, "chin": 0, "noseWidth": 0, "noseLength": 0, "eyeSize": 0, "lips": 0, "cheekbones": 0, "browAngle": 0, "feminine": 0},
        "skin": "young_caucasian_female", "eyes": "green", "eyebrows": "eyebrow003",
        "hair": "long01", "hairColour": None, "hairTint": None, "lips": None,
        "clothes": ["punkduck_sleeveless_crop_top", "elvs_jeans_bootcut", "shoes02"],
    }
