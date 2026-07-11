"""Backend registry: name -> CodingAgentBackend class.

Ported from strands_studio_ui ``backend/codegen/backends/registry.py``
(origin/main); only the import paths changed (``codegen`` -> ``app.codegen``).
Future backends (Codex / Kiro) add one module + one entry here; the service
layer stays unchanged.
"""


from app.codegen import config
from app.codegen.backends.base import CodingAgentBackend
from app.codegen.backends.claude_sdk import ClaudeSdkBackend

_BACKENDS: dict[str, type[CodingAgentBackend]] = {
    "claude": ClaudeSdkBackend,
    # future: "codex": CodexBackend, "kiro": KiroBackend
}


class UnknownBackendError(ValueError):
    """Raised when the configured backend name is not registered."""


def available_backends() -> list[str]:
    return sorted(_BACKENDS.keys())


def get_backend(name: str | None = None) -> CodingAgentBackend:
    """Instantiate the selected backend (new instance per generation request).

    Raises UnknownBackendError with the list of registered backends when the
    configured name is unknown.
    """
    backend_name = name or config.get_backend_name()
    backend_cls = _BACKENDS.get(backend_name)
    if backend_cls is None:
        raise UnknownBackendError(
            f"Unknown codegen backend '{backend_name}'. "
            f"Available backends: {', '.join(available_backends())}. "
            f"Set codegen_backend (LAUNCHPAD_CODEGEN_BACKEND) to one of these."
        )
    return backend_cls()
