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

# Force line-buffered stdout even when not a TTY (piped from Rust).
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


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


class Engine:
    def __init__(self) -> None:
        self.model = None
        self.quant: int | None = None

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
            seed = int(cmd.get("seed") if cmd.get("seed") is not None else os.urandom(4).hex(), 16) & 0x7FFFFFFF
        except (TypeError, ValueError) as e:
            emit({"event": "error", "message": f"bad generate params: {e}"})
            return

        # Snap to multiples of 16 — DiT latents are 8× downsampled and packed.
        width = max(256, (width // 16) * 16)
        height = max(256, (height // 16) * 16)

        emit({"event": "progress", "step": 0, "total": steps})
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
