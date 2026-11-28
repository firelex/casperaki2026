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
