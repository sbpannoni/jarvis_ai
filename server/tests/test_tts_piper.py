import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as srv  # noqa: E402


def test_resample_pcm16_noop_when_rates_match():
    src = bytes([1, 2, 3, 4])
    assert srv._resample_pcm16(src, 16000, 16000) == src


def test_resample_pcm16_noop_on_empty_input():
    assert srv._resample_pcm16(b"", 22050, 16000) == b""


def test_resample_pcm16_scales_sample_count_by_rate_ratio():
    one_second_at_22050 = np.zeros(22050, dtype=np.int16).tobytes()
    out = srv._resample_pcm16(one_second_at_22050, 22050, 16000)
    out_sample_count = len(out) // 2  # 2 bytes per int16 sample
    assert out_sample_count == 16000


def test_tts_piper_chunks_resamples_to_16k(monkeypatch):
    class FakeAudioChunk:
        def __init__(self, audio_int16_bytes):
            self.audio_int16_bytes = audio_int16_bytes

    class FakeConfig:
        sample_rate = 22050

    class FakeVoice:
        config = FakeConfig()

        def synthesize(self, text):
            # piper-tts (piper1-gpl) yields one AudioChunk per sentence,
            # not raw bytes per callback -- mock that exact shape.
            # 0.1s of silence at the voice's native 22050Hz
            yield FakeAudioChunk(np.zeros(2205, dtype=np.int16).tobytes())

    monkeypatch.setattr(srv, "_get_piper_voice", lambda: FakeVoice())
    chunks = list(srv._tts_piper_chunks("hello"))
    total_samples = sum(len(c) for c in chunks) // 2
    assert total_samples == 1600  # 0.1s at 16000Hz
