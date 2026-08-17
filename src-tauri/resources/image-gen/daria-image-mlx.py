#!/usr/bin/env python3
"""DARIA Z-Image-Turbo MLX sidecar.

JSON-lines on stdin/stdout (logs on stderr). The Rust host starts this only
when the user actually generates, and kills the process to unload weights.

  → {"cmd":"ping"}
  → {"cmd":"load","quant":8}
  → {"cmd":"generate","prompt":"...","width":1024,"height":1024,"steps":9,"seed":42,"out":"/abs/path.png"}
  → {"cmd":"unload"}
  → {"cmd":"quit"}

  ← {"event":"ready"}
  ← {"event":"loadProgress","frac":0.2,"message":"..."}
  ← {"event":"loaded","quant":8}
  ← {"event":"progress","step":3,"total":9}
  ← {"event":"done","path":"..."}
  ← {"event":"unloaded"}
  ← {"event":"error","message":"..."}
"""

from __future__ import annotations

import json
import os
import sys
import traceback

# Libraries (huggingface_hub, tqdm, mlx) love stdout. Steal it before they
# import so the Rust host only ever sees protocol lines.
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TQDM_DISABLE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

_REAL_STDOUT = sys.stdout


class _StderrOnly:
    """Stand-in for sys.stdout: anything printed by deps goes to stderr."""

    def write(self, s):
        if s:
            sys.stderr.write(s)
        return len(s) if s else 0

    def flush(self):
        sys.stderr.flush()

    def reconfigure(self, *args, **kwargs):
        return None

    def fileno(self):
        return sys.stderr.fileno()

    def isatty(self):
        return False


sys.stdout = _StderrOnly()


def emit(obj: dict) -> None:
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


def log(msg: str) -> None:
    sys.stderr.write(f"daria-image-mlx: {msg}\n")
    sys.stderr.flush()


def parse_quant(raw) -> int | None:
    """4 / 8 → quantized; 16 / 0 / None → full precision."""
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    if n in (4, 8):
        return n
    return None


class _StepProgress:
    """mflux InLoopCallback — one emit per denoising step, never a 0/N teaser."""

    def __init__(self, state: dict) -> None:
        self.state = state

    def call_in_loop(self, t, seed, prompt, latents, config, time_steps) -> None:
        n = int(self.state.get("step") or 0) + 1
        total = int(self.state.get("total") or 9)
        self.state["step"] = n
        emit({"event": "progress", "step": min(n, total), "total": total})


class Engine:
    def __init__(self) -> None:
        self.model = None
        self.quant: int | None = None
        self._progress = {"step": 0, "total": 9}

    def load(self, quant_raw) -> None:
        q = parse_quant(quant_raw)
        if self.model is not None and self.quant == q:
            emit({"event": "loaded", "quant": q if q is not None else 16})
            return
        self.unload()
        emit({"event": "loadProgress", "frac": 0.05, "message": "importing MLX"})
        try:
            from mflux.models.z_image import ZImageTurbo
        except Exception as e:
            emit({"event": "error", "message": f"mflux is not installed: {e}"})
            return
        emit({"event": "loadProgress", "frac": 0.15, "message": "loading Z-Image-Turbo"})
        try:
            self.model = ZImageTurbo(quantize=q)
            self.quant = q
            if hasattr(self.model, "callbacks"):
                self.model.callbacks.register(_StepProgress(self._progress))
        except Exception as e:
            log(traceback.format_exc())
            emit({"event": "error", "message": f"failed to load Z-Image-Turbo: {e}"})
            self.model = None
            self.quant = None
            return
        emit({"event": "loadProgress", "frac": 1.0, "message": "ready"})
        emit({"event": "loaded", "quant": q if q is not None else 16})

    def unload(self) -> None:
        if self.model is None:
            emit({"event": "unloaded"})
            return
        self.model = None
        self.quant = None
        try:
            import mlx.core as mx

            mx.clear_cache()
        except Exception:
            pass
        emit({"event": "unloaded"})

    def generate(self, cmd: dict) -> None:
        if self.model is None:
            emit({"event": "error", "message": "model is not loaded"})
            return
        prompt = (cmd.get("prompt") or "").strip()
        if not prompt:
            emit({"event": "error", "message": "prompt is empty"})
            return
        out = cmd.get("out")
        if not out:
            emit({"event": "error", "message": "output path is missing"})
            return
        try:
            width = max(256, min(2048, int(cmd.get("width") or 1024)))
            height = max(256, min(2048, int(cmd.get("height") or 1024)))
            steps = max(1, min(50, int(cmd.get("steps") or 9)))
            if cmd.get("seed") is not None:
                seed = int(cmd.get("seed")) & 0x7FFFFFFF
            else:
                seed = int.from_bytes(os.urandom(4), "big") & 0x7FFFFFFF
        except (TypeError, ValueError) as e:
            emit({"event": "error", "message": f"bad generate params: {e}"})
            return

        # Snap to multiples of 16 — DiT latents are 8× downsampled and packed.
        width = max(256, (width // 16) * 16)
        height = max(256, (height // 16) * 16)

        self._progress["step"] = 0
        self._progress["total"] = steps
        try:
            image = self.model.generate_image(
                prompt=prompt,
                seed=seed,
                num_inference_steps=steps,
                width=width,
                height=height,
            )
        except KeyboardInterrupt:
            emit({"event": "error", "message": "cancelled"})
            return
        except Exception as e:
            log(traceback.format_exc())
            emit({"event": "error", "message": f"generation failed: {e}"})
            return

        parent = os.path.dirname(out)
        if parent:
            os.makedirs(parent, exist_ok=True)
        try:
            if hasattr(image, "save"):
                image.save(out)
            elif hasattr(image, "image"):
                image.image.save(out)
            else:
                emit({"event": "error", "message": "mflux returned an unsavable image"})
                return
        except Exception as e:
            emit({"event": "error", "message": f"failed to save image: {e}"})
            return
        emit({"event": "progress", "step": steps, "total": steps})
        emit({"event": "done", "path": out, "seed": seed, "width": width, "height": height})


def main() -> int:
    engine = Engine()
    emit({"event": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"event": "error", "message": f"bad json: {e}"})
            continue
        name = cmd.get("cmd")
        if name == "ping":
            emit({"event": "ready"})
        elif name == "load":
            engine.load(cmd.get("quant"))
        elif name == "generate":
            engine.generate(cmd)
        elif name == "unload":
            engine.unload()
        elif name == "quit":
            engine.unload()
            return 0
        else:
            emit({"event": "error", "message": f"unknown cmd: {name}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
