package main

import (
	"image"
	"image/png"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

// Löschen, Neues und Suche „nur in diesem Ordner“ wirken sofort auf den Index.
func TestIndexExplorerFunktionen(t *testing.T) {
	root := t.TempDir()
	mk := func(p string) {
		full := filepath.Join(root, p)
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, []byte("x"), 0o644)
	}
	mk("Kunden/Wrobel/Angebot.pdf")
	mk("Kunden/Wrobel/Schaden/Foto.jpg")
	mk("Kunden/Mueller/Angebot.pdf")
	var stop atomic.Bool
	p := &Progress{}
	p.Current.Store("")
	ix := BuildIndex([]string{root}, nil, 2, &stop, p)

	under := filepath.Join(root, "Kunden", "Wrobel")
	res, total, _ := ix.Search(Query{Text: "angebot", Under: under}, func() bool { return false })
	if total != 1 || len(res) != 1 {
		t.Fatalf("Suche im Ordner: %d Treffer, erwartet 1", total)
	}
	if !ix.Covers(under) || ix.Covers(t.TempDir()) {
		t.Fatal("Covers falsch")
	}

	nx := ix.WithRemoved([]string{filepath.Join(root, "Kunden", "Wrobel")})
	if _, total, _ := nx.Search(Query{Text: "foto"}, func() bool { return false }); total != 0 {
		t.Fatal("gelöschter Ordner noch im Index")
	}
	if _, total, _ := nx.Search(Query{Text: "angebot"}, func() bool { return false }); total != 1 {
		t.Fatal("falsches gelöscht")
	}

	mk("Kunden/Mueller/Neu.docx")
	ax := nx.WithAdded([]string{filepath.Join(root, "Kunden", "Mueller", "Neu.docx"), filepath.Join(root, "Kunden", "Mueller", "Neu.docx")})
	if _, total, _ := ax.Search(Query{Text: "neu.docx"}, func() bool { return false }); total != 1 {
		t.Fatalf("neue Datei: %d Treffer, erwartet 1", total)
	}

	lix, lres, ltotal, _ := LiveSearch(filepath.Join(root, "Kunden"), Query{Text: "*.pdf"}, nil, func() bool { return false })
	if ltotal != 2 || len(lres) != 2 || len(lix.Entries) != 2 {
		t.Fatalf("Direktsuche: %d Treffer, erwartet 2", ltotal)
	}
}

// Vorschaubilder und Textvorschau (ohne Windows: Bilder werden selbst verkleinert).
func TestVorschau(t *testing.T) {
	dir := t.TempDir()
	img := image.NewRGBA(image.Rect(0, 0, 800, 400))
	f, _ := os.Create(filepath.Join(dir, "bild.png"))
	png.Encode(f, img)
	f.Close()
	th, err := Thumbnail(filepath.Join(dir, "bild.png"), 200)
	if err != nil || th.Bounds().Dx() != 200 || th.Bounds().Dy() != 100 {
		t.Fatalf("Miniatur: %v %v", err, th)
	}
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("\xef\xbb\xbfZeile 1\nGr\xfc\xdfe"), 0o644)
	txt, err := peekText(filepath.Join(dir, "a.txt"))
	if err != nil || txt != "Zeile 1\nGrüße" {
		t.Fatalf("Textvorschau: %q %v", txt, err)
	}
	if got := decodeText([]byte("Gr\xc3\xbc\xc3")); got != "Grü" { // nach 32 KB abgeschnittenes Zeichen
		t.Fatalf("abgeschnitten: %q", got)
	}
	if !isTextFile("Notiz.TXT") || isTextFile("bild.png") {
		t.Fatal("isTextFile")
	}
}
