"""The lines stage checks every line before any model loads."""
import pytest

from pipeline import lines


def line(**kw):
    return {"id": "ice-1", "text": "Right.", "instruction": "A man.", "seed": 7, **kw}


@pytest.mark.parametrize("given, message", [
    ([], "no lines"),
    ([{"id": "a", "instruction": "x", "seed": 1}], "text"),
    ([line(), line()], "twice"),
    ([line(id="Ice 1")], "id"),
    ([line(text="  ")], "text"),
    ([line(instruction="")], "instruction"),
    ([line(seed="7")], "seed"),
])
def test_refuses_bad_lines(tmp_path, given, message):
    with pytest.raises(ValueError, match=message):
        lines.run({"stage": "lines", "lines": given}, str(tmp_path), None)


@pytest.mark.parametrize("given, message", [
    ([line(direction="dry")], "direction"),
    ([line(reference_text="  ")], "reference_text"),
    ([line(reference_text="Hello there.", direction=5)], "direction"),
])
def test_refuses_bad_references(tmp_path, given, message):
    with pytest.raises(ValueError, match=message):
        lines.run({"stage": "lines", "lines": given}, str(tmp_path), None)


def test_copies_each_line_from_one_reference_per_voice(tmp_path, monkeypatch):
    """A line with reference_text: the voice's reference (its description and seed saying reference_text) is made once,
    and every line of that voice is copied from it, steered by its direction."""
    import numpy as np
    import soundfile as sf

    from pipeline import breeze

    calls = []

    class FakeBreeze:
        def speak(self, text, instruction, seed, out, ref_audio=None, ref_text=None):
            calls.append({"text": text, "instruction": instruction, "seed": seed, "ref_audio": ref_audio, "ref_text": ref_text})
            out.parent.mkdir(parents=True, exist_ok=True)
            sf.write(out, 0.2 * np.sin(np.linspace(0, 2000, 24000)), 24000)
            return out

        def close(self):
            pass

    monkeypatch.setattr(breeze, "Breeze", FakeBreeze)
    ice = {"instruction": "A dry English man.", "seed": 7, "reference_text": "Right then, let us begin."}
    given = [{"id": "ice-1", "text": "Shame about the verses.", "direction": "withering", **ice},
             {"id": "ice-2", "text": "Yes. Well done.", **ice},
             {"id": "bob-1", "text": "Grand!", "instruction": "An Irish man.", "seed": 21, "reference_text": "Ah sure, how are you."}]
    lines.run({"stage": "lines", "lines": given}, str(tmp_path), None)
    refs = [c for c in calls if c["ref_audio"] is None]
    assert [(c["text"], c["seed"]) for c in refs] == [("Right then, let us begin.", 7), ("Ah sure, how are you.", 21)]
    copied = [c for c in calls if c["ref_audio"] is not None]
    assert [c["text"] for c in copied] == ["Shame about the verses.", "Yes. Well done.", "Grand!"]
    assert copied[0]["instruction"] == "withering" and copied[1]["instruction"] is None
    assert copied[0]["ref_text"] == "Right then, let us begin."
    assert copied[0]["ref_audio"] == copied[1]["ref_audio"] != copied[2]["ref_audio"]
    assert all((tmp_path / f"{g['id']}.wav").is_file() for g in given)
