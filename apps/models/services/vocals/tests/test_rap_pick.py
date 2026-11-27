import math

import pytest

from pipeline.rap_pick import TakeScore, best_take, word_recall, words_of


def test_words_of_drops_case_punctuation_and_apostrophes():
    assert words_of("Chasin' the SUN, I'm done!") == ["chasin", "the", "sun", "im", "done"]


def test_word_recall_counts_words_heard_in_order():
    words = "Woke up early with the city in my chest"
    assert word_recall(words, "woke up early with the city in my chest") == 1.0
    assert word_recall(words, "I woke up early, the city in my chest") == pytest.approx(8 / 9)
    assert word_recall(words, "Thank you.") == 0.0


def test_word_recall_needs_words():
    with pytest.raises(ValueError, match="no words"):
        word_recall("", "anything")


def test_best_take_most_words_then_cleanest_separation():
    s = [
        TakeScore(0.6, -20.0, -30.0, "a"),
        TakeScore(0.9, -20.0, -25.0, "b"),
        TakeScore(0.9, -20.0, -45.0, "c"),
        TakeScore(0.0, -math.inf, -20.0, "silent"),
    ]
    assert best_take(s) == 2


def test_silent_take_scores_json_without_infinities():
    assert TakeScore(0.0, -math.inf, -20.0, "").as_json() == {"recall": 0.0, "vocal_db": None, "backing_db": -20.0, "heard": ""}
