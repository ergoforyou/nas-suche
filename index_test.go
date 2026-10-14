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
		{Query{Text: "müller", Filter: FilterBit(CatPDF)}, 0},
		{Query{Text: "müller", Filter: FilterBit(CatFolder)}, 2},
		{Query{Filter: FilterBit(CatPDF)}, 2},
		{Query{Text: "angebot", Filter: FilterBit(CatOffice)}, 1},
		{Query{Text: "rechnung müller", InPath: true}, 1},
		{Query{Text: "rechnung müller"}, 0},
		{Query{Text: "thumb"}, 0},
		{Query{Text: "*.pdf", Filter: FilterBit(CatPDF)}, 2},
		{Query{Text: "müller", Filter: FilterBit(CatPDF) | FilterBit(CatFolder)}, 2},
		{Query{Text: "angebot", Filter: FilterBit(CatPDF) | FilterBit(CatOffice)}, 2},
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
	_, total, c := ix.Search(Query{Text: "plan", Filter: FilterBit(CatPDF)}, func() bool { return false })
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

func TestWithMoves(t *testing.T) {
	ix := &Index{
		Dirs: []string{filepath.FromSlash("/nas/Kunden"), filepath.FromSlash("/nas/Kunden/Müller"), filepath.FromSlash("/nas/Archiv")},
		Entries: []Entry{
			{Name: "Müller", Dir: 0, IsDir: true},
			{Name: "Angebot.pdf", Dir: 1},
			{Name: "Rechnung.pdf", Dir: 0},
			{Name: "Archiv", Dir: 0, IsDir: true},
		},
	}
	ix.prepare()
	nx := ix.WithMoves(map[string]string{
		filepath.FromSlash("/nas/Kunden/Rechnung.pdf"): filepath.FromSlash("/nas/Archiv/Rechnung.pdf"),
		filepath.FromSlash("/nas/Kunden/Müller"):       filepath.FromSlash("/nas/Archiv/Müller"),
	})
	never := func() bool { return false }
	path := func(x *Index, q string) string {
		res, _, _ := x.Search(Query{Text: q}, never)
		if len(res) != 1 {
			return fmt.Sprint(len(res), " Treffer")
		}
		return x.Path(&x.Entries[res[0]])
	}
	if p := path(nx, "rechnung"); p != filepath.FromSlash("/nas/Archiv/Rechnung.pdf") {
		t.Errorf("Rechnung: %s", p)
	}
	if p := path(nx, "angebot"); p != filepath.FromSlash("/nas/Archiv/Müller/Angebot.pdf") {
		t.Errorf("Angebot im verschobenen Ordner: %s", p)
	}
	if p := path(nx, "müller"); p != filepath.FromSlash("/nas/Archiv/Müller") {
		t.Errorf("Ordner: %s", p)
	}
	if p := path(ix, "rechnung"); p != filepath.FromSlash("/nas/Kunden/Rechnung.pdf") {
		t.Errorf("alter Index verändert: %s", p)
	}
}

func TestWithMovesRename(t *testing.T) {
	ix := &Index{
		Dirs: []string{filepath.FromSlash("/nas/Kunden"), filepath.FromSlash("/nas/Kunden/Müller")},
		Entries: []Entry{
			{Name: "Müller", Dir: 0, IsDir: true},
			{Name: "Scan_0001.pdf", Dir: 1},
		},
	}
	ix.prepare()
	nx := ix.WithMoves(map[string]string{
		filepath.FromSlash("/nas/Kunden/Müller/Scan_0001.pdf"): filepath.FromSlash("/nas/Kunden/Müller/Rechnung Müller.pdf"),
		filepath.FromSlash("/nas/Kunden/Müller"):               filepath.FromSlash("/nas/Kunden/Müller GmbH"),
	})
	never := func() bool { return false }
	res, _, _ := nx.Search(Query{Text: "rechnung"}, never)
	if len(res) != 1 || nx.Path(&nx.Entries[res[0]]) != filepath.FromSlash("/nas/Kunden/Müller GmbH/Rechnung Müller.pdf") {
		t.Fatalf("umbenannte Datei nicht gefunden: %v", res)
	}
	if res, _, _ := nx.Search(Query{Text: "scan"}, never); len(res) != 0 {
		t.Errorf("alter Name noch gefunden")
	}
	if res, _, _ := nx.Search(Query{Text: "gmbh"}, never); len(res) != 1 {
		t.Errorf("umbenannter Ordner nicht gefunden")
	}
	if res, _, _ := ix.Search(Query{Text: "scan"}, never); len(res) != 1 {
		t.Errorf("alter Index verändert")
	}
}
