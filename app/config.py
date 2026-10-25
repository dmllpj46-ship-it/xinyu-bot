"""集中配置：只读 .env，不做任何业务逻辑。"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── 模型 ──────────────────────────────────────────────
    inception_api_key: str = Field(..., alias="INCEPTION_API_KEY")
    inception_base_url: str = Field("https://api.inceptionlabs.ai/v1", alias="INCEPTION_BASE_URL")
    mercury_model: str = Field("mercury-3", alias="MERCURY_MODEL")
    mercury_reasoning_effort: str = Field("low", alias="MERCURY_REASONING_EFFORT")
    # Mercury 3 只接受 0.5–1.0，越界会被服务端拒绝
    mercury_temperature: float = Field(0.75, alias="MERCURY_TEMPERATURE")

    # ── 联网搜索 ──────────────────────────────────────────
    anysearch_api_key: str = Field("", alias="ANYSEARCH_API_KEY")
    anysearch_base_url: str = Field("https://api.anysearch.com", alias="ANYSEARCH_BASE_URL")

    # ── 应用 ──────────────────────────────────────────────
    app_host: str = Field("127.0.0.1", alias="APP_HOST")
    app_port: int = Field(8000, alias="APP_PORT")
    kb_dir: Path = Field(Path("knowledge"), alias="KB_DIR")
    kb_index: Path = Field(Path("data/kb_index.json"), alias="KB_INDEX")
    max_turns_per_session: int = Field(20, alias="MAX_TURNS_PER_SESSION")
    crisis_mode: str = Field("strict", alias="CRISIS_MODE")
    log_level: str = Field("INFO", alias="LOG_LEVEL")

    @field_validator("mercury_temperature")
    @classmethod
    def _clamp_temperature(cls, v: float) -> float:
        # Mercury 3 的硬限制：0.5–1.0。越界不是"稍微偏一点"，是直接 400。
        return min(1.0, max(0.5, v))

    @field_validator("mercury_reasoning_effort")
    @classmethod
    def _check_effort(cls, v: str) -> str:
        allowed = {"instant", "low", "medium", "high"}
        if v not in allowed:
            raise ValueError(f"MERCURY_REASONING_EFFORT 只能是 {sorted(allowed)}，收到 {v!r}")
        return v

    @property
    def kb_dir_abs(self) -> Path:
        return self.kb_dir if self.kb_dir.is_absolute() else ROOT / self.kb_dir

    @property
    def kb_index_abs(self) -> Path:
        return self.kb_index if self.kb_index.is_absolute() else ROOT / self.kb_index

    @property
    def web_dir(self) -> Path:
        return ROOT / "web"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    try:
        return Settings()  # type: ignore[call-arg]
    except Exception as exc:  # pydantic 的报错对使用者不友好，这里翻成一句话
        raise RuntimeError(
            "配置读取失败。请确认项目根目录存在 .env，且至少包含 INCEPTION_API_KEY。"
            f"（原始错误：{exc}）"
        ) from exc
