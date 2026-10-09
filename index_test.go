package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestBuildAndSearch(t *testing.T) {
	root := t.TempDir()
	mk := func(p string) {
		full := filepath.Join(root, p)
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, []byte("x"), 0o644)
	}
	mk("Kunden/Müller GmbH/Angebot 2026.pdf")
	mk("Kunden/Müller AG/Rechnung.pdf") // macOS-Schreibweise (NFD)
	mk("Kunden/Meier/Angebot.docx")
	mk("#recycle/Angebot alt.pdf")
	mk("@eaDir/thumb.jpg")

	var stop atomic.Bool
	p := &Progress{}
	ix := BuildIndex([]string{root}, defaultConfig().Excludes, 4, &stop, p)

	path := filepath.Join(t.TempDir(), "index.dat")
	if err := SaveIndex(ix, path); err != nil {
		t.Fatal(err)
	}
	ix, err := LoadIndex(path)
	if err != nil {
		t.Fatal(err)
	}

	never := func() bool { return false }
	cases := []struct {
		q      Query
		expect int
	}{
		{Query{Text: "angebot"}, 2},
		{Query{Text: "ANGEBOT *.pdf"}, 1},
		{Query{Text: "müller"}, 2}, // NFC + NFD
		{Query{Text: "müller", Filter: CatPDF}, 0},
		{Query{Text: "müller", Filter: CatFolder}, 2},
		{Query{Filter: CatPDF}, 2},
		{Query{Text: "angebot", Filter: CatOffice}, 1},
		{Query{Text: "rechnung müller", InPath: true}, 1},
		{Query{Text: "rechnung müller"}, 0},
		{Query{Text: "thumb"}, 0},
		{Query{Text: "*.pdf", Filter: CatPDF}, 2},
		{Query{}, 0},
	}
	for _, c := range cases {
		res, total, _ := ix.Search(c.q, never)
		if total != c.expect || len(res) != total {
			t.Errorf("%+v: %d Treffer, erwartet %d", c.q, total, c.expect)
		}
	}
}

func TestGlob(t *testing.T) {
	for _, c := range []struct {
		p, s string
		ok   bool
	}{{"*.pdf", "a.pdf", true}, {"*.pdf", "a.pdfx", false}, {"a?c*", "abcdef", true}, {"*mü*", "xmüy", true}} {
		if globMatch(c.p, c.s) != c.ok {
			t.Errorf("%s ~ %s", c.p, c.s)
		}
	}
}

func TestNaturalLess(t *testing.T) {
	if !naturalLess("ordner 2", "ordner 10") || naturalLess("ordner 10", "ordner 2") || !naturalLess("a", "b") || !naturalLess("abc", "abcd") {
		t.Error("naturalLess falsch")
	}
}

func TestCounts(t *testing.T) {
	ix := &Index{Dirs: []string{`x`}, Entries: []Entry{{Name: "Plan.PDF"}, {Name: "Foto.JPG"}, {Name: "Liste.xlsx"},
		{Name: "Plan", IsDir: true}, {Name: "plan.txt"}}}
	ix.prepare()
	_, total, c := ix.Search(Query{Text: "plan", Filter: CatPDF}, func() bool { return false })
	if total != 1 || c[CatAll] != 3 || c[CatPDF] != 1 || c[CatFolder] != 1 || c[CatOther] != 1 || c[CatImage] != 0 {
		t.Fatalf("total=%d counts=%v", total, c)
	}
}

func TestSearchSpeed(t *testing.T) {
	ix := &Index{Dirs: []string{`\\nas\daten\projekte`}}
	for i := 0; i < 1_000_000; i++ {
		ix.Entries = append(ix.Entries, Entry{Name: fmt.Sprintf("Dokument %d Kunde %d.pdf", i, i%977)})
	}
	ix.prepare()
	start := time.Now()
	_, total, _ := ix.Search(Query{Text: "kunde 12 pdf", MaxResult: 100000}, func() bool { return false })
	t.Logf("1 Mio. Einträge: %d Treffer in %s", total, time.Since(start))
}
