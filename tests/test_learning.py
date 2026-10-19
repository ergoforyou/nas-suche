from diktierflow import learning


def test_extract_name_correction():
    inserted = "Ich habe gestern mit Ergo vor ju telefoniert."
    edited = "Ich habe gestern mit ErgoForYou telefoniert."
    assert learning.extract_corrections(inserted, edited) == [("Ergo vor ju", "ErgoForYou")]


def test_extract_phonetic_misspelling():
    inserted = "Bitte schick das an Herrn Maier."
    edited = "Bitte schick das an Herrn Meyer."
    assert learning.extract_corrections(inserted, edited) == [("Maier", "Meyer")]


def test_content_change_is_not_learned():
    inserted = "Wir treffen uns am Montag um zehn."
    edited = "Wir treffen uns am Dienstag um zehn."
    assert learning.extract_corrections(inserted, edited) == []


def test_grammar_change_is_not_learned():
    assert learning.extract_corrections("Das ist der schöne Tag.",
                                        "Das ist ein schöner Tag.") == []


def test_full_rewrite_is_not_learned():
    assert learning.extract_corrections("Kurzer Satz über Wetter heute.",
                                        "Komplett anderer Inhalt mit neuen Worten hier.") == []


def test_capitalisation_of_name_mid_sentence():
    pairs = learning.extract_corrections("Gestern hat müller angerufen.",
                                         "Gestern hat Müller angerufen.")
    assert pairs == [("müller", "Müller")]


def test_capitalisation_at_sentence_start_is_ignored():
    assert learning.extract_corrections("heute regnet es.", "Heute regnet es.") == []


def test_locate_inserted_in_longer_field():
    field = "Hallo Team,\n\nIch habe gestern mit ErgoForYou telefoniert. Gruß Jens"
    inserted = "Ich habe gestern mit Ergo vor ju telefoniert."
    region = learning.locate_inserted(field, inserted)
    assert region == "Ich habe gestern mit ErgoForYou telefoniert."


def test_locate_inserted_unrelated_field():
    assert learning.locate_inserted("ganz etwas anderes", "Ich habe gestern telefoniert.") is None


def test_apply_corrections_keeps_sentence_case():
    text = "ergo vor ju ist super. Ich mag Ergo vor ju."
    out = learning.apply_corrections(text, [("Ergo vor ju", "ErgoForYou")])
    assert out == "ErgoForYou ist super. Ich mag ErgoForYou."


def test_apply_corrections_whole_words_only():
    assert learning.apply_corrections("Maierhofer", [("Maier", "Meyer")]) == "Maierhofer"


def test_vocabulary_candidates():
    assert "ErgoForYou" in learning.vocabulary_candidates("ErgoForYou")
    assert learning.vocabulary_candidates("Haus") == []


def test_cologne_phonetic_examples():
    # Standardbeispiele der Kölner Phonetik
    assert learning.cologne_phonetic("Müller-Lüdenscheidt") == "65752682"
    assert learning.cologne_phonetic("Meier") == learning.cologne_phonetic("Mayr")


def test_stt_prompt_limit():
    prompt = learning.build_stt_prompt(["A" * 100] * 10, [], max_chars=250)
    assert len(prompt) <= 250


def test_name_spelling_with_same_stem_is_learned():
    assert learning.extract_corrections("Termin mit Frau Schmid.",
                                        "Termin mit Frau Schmidt.") == [("Schmid", "Schmidt")]
