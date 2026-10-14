from agentur_pdf.windows.explorer import als_reg_datei, eintraege

AUFRUF = r'"C:\Programme\Agentur-PDF\Agentur-PDF.exe"'


def befehl(liste, endung, verb):
    pfad = rf"Software\Classes\SystemFileAssociations\{endung}\shell\{verb}\command"
    return next(dict(s.werte)[""] for s in liste if s.pfad == pfad)


def test_eintraege_fuer_typen():
    liste = eintraege(AUFRUF)
    assert befehl(liste, ".docx", "AgenturPDF.2Zusammenfuehren") == AUFRUF + ' --zusammenfuehren "%1"'
    assert befehl(liste, ".jpg", "AgenturPDF.3Umwandeln") == AUFRUF + ' --umwandeln "%1"'
    assert befehl(liste, ".pdf", "AgenturPDF.1Oeffnen") == AUFRUF + ' "%1"'
    # „In PDF umwandeln“ ergibt bei PDFs keinen Sinn
    assert not any(s.pfad.endswith(r"\.pdf\shell\AgenturPDF.3Umwandeln") for s in liste)
    # Mehrfachauswahl auch bei mehr als 15 Dateien
    verb = next(s for s in liste if s.pfad.endswith(r"\.msg\shell\AgenturPDF.2Zusammenfuehren"))
    assert ("MultiSelectModel", "Player") in verb.werte
    assert ("MUIVerb", "Zu einer PDF zusammenführen") in verb.werte


def test_reg_export_escaped():
    text = als_reg_datei(eintraege(AUFRUF))
    assert text.startswith("Windows Registry Editor Version 5.00")
    assert r'@="\"C:\\Programme\\Agentur-PDF\\Agentur-PDF.exe\" --zusammenfuehren \"%1\""' in text
