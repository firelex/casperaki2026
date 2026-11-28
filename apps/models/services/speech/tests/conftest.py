import sys
from pathlib import Path

# The service's own code (pipeline/) is imported as a package from the service folder.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
