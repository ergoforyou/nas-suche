"""bild2vrm – erzeugt lokal aus einem Ganzkörperbild einen geriggten VRM-Avatar."""

from .avatar import Options, Result, Views, analyze, generate

__version__ = "1.1.0"
__all__ = ["Options", "Result", "Views", "analyze", "generate", "__version__"]
