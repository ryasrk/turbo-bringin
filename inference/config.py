"""Inference configuration for standard and turboquant modes."""

from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum


class InferenceMode(str, Enum):
    STANDARD = "standard"
    TURBOQUANT = "turboquant"


@dataclass
class ModelConfig:
    model_path: str = "models/Bonsai-8B-Q1_0.gguf"
    engine_path: str = "engines/llama-cpp-prismml/build/bin/llama-server"
    n_gpu_layers: int = 99
    ctx_size: int = 8192
    parallel_slots: int = 1


@dataclass
class StandardConfig:
    """f16 KV cache, no flash attention — maximum quality baseline."""
    cache_type_k: str = "f16"
    cache_type_v: str = "f16"
    flash_attn: str = "off"
    port: int = 8080
    description: str = "Standard mode: f16 KV cache, full precision"


@dataclass
class TurboQuantConfig:
    """q4_0 KV cache + flash attention — 72% VRAM savings, same accuracy."""
    cache_type_k: str = "q4_0"
    cache_type_v: str = "q4_0"
    flash_attn: str = "on"
    port: int = 8081
    description: str = "TurboQuant mode: q4_0 KV + FA, 72% VRAM savings"


@dataclass
class ServerConfig:
    host: str = "0.0.0.0"
    api_key: str = ""
    log_level: str = "info"


def get_mode_config(mode: InferenceMode) -> StandardConfig | TurboQuantConfig:
    if mode == InferenceMode.STANDARD:
        return StandardConfig()
    return TurboQuantConfig()
