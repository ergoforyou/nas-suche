package main

import (
	"bufio"
	"compress/gzip"
	"encoding/gob"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/text/unicode/norm"
)

// Entry ist eine Datei oder ein Ordner im Index.
type Entry struct {
	Name  string
	Dir   int32 // Index in Index.Dirs
	IsDir bool
	Size  int64
	Mod   int64 // Unix-Sekunden
}

// Index hält alle gefundenen Einträge im Speicher.
type Index struct {
	Roots   []string
	Dirs    []string
	Entries []Entry
	Built   time.Time
	Errors  int

	lowerNames []string // nicht gespeichert, wird beim Laden berechnet
	lowerDirs  []string
	cats       []uint8
}

func normLower(s string) string {
	return norm.NFC.String(strings.ToLower(s))
}

func (ix *Index) prepare() {
	ix.lowerNames = make([]string, len(ix.Entries))
	ix.cats = make([]uint8, len(ix.Entries))
	for i := range ix.Entries {
		ix.lowerNames[i] = normLower(ix.Entries[i].Name)
		ix.cats[i] = categoryOf(ix.lowerNames[i], ix.Entries[i].IsDir)
	}
	ix.lowerDirs = make([]string, len(ix.Dirs))
	for i, d := range ix.Dirs {
		ix.lowerDirs[i] = normLower(d)
	}
}

func (ix *Index) Path(e *Entry) string {
	return filepath.Join(ix.Dirs[e.Dir], e.Name)
}

// Progress wird während des Einlesens laufend aktualisiert.
type Progress struct {
	Files   atomic.Int64
	Folders atomic.Int64
	Errors  atomic.Int64
	Current atomic.Value // string
}

// BuildIndex liest alle Wurzelordner parallel ein.
func BuildIndex(roots, excludes []string, workers int, stop *atomic.Bool, p *Progress) *Index {
	ix := &Index{Roots: roots}
	excl := make(map[string]bool)
	for _, e := range excludes {
		if e = strings.TrimSpace(e); e != "" {
			excl[strings.ToLower(e)] = true
		}
	}

	var (
		mu      sync.Mutex
		cond    = sync.NewCond(&mu)
		queue   []string
		pending int
	)
	for _, r := range roots {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		queue = append(queue, filepath.Clean(r))
		pending++
	}

	worker := func() {
		for {
			mu.Lock()
			for len(queue) == 0 && pending > 0 && !stop.Load() {
				cond.Wait()
			}
			if len(queue) == 0 || stop.Load() {
				cond.Broadcast()
				mu.Unlock()
				return
			}
			dir := queue[len(queue)-1]
			queue = queue[:len(queue)-1]
			mu.Unlock()

			p.Current.Store(dir)
			ents, err := os.ReadDir(dir)
			if err != nil {
				p.Errors.Add(1)
			}
			local := make([]Entry, 0, len(ents))
			var subdirs []string
			for _, de := range ents {
				name := de.Name()
				// "._…" = Mac-Begleitdateien auf dem NAS, nicht suchen
				if excl[strings.ToLower(name)] || strings.HasPrefix(name, "NasSuche-Index.dat") || strings.HasPrefix(name, "._") {
					continue
				}
				e := Entry{Name: name, IsDir: de.IsDir()}
				if info, err := de.Info(); err == nil {
					e.Mod = info.ModTime().Unix()
					if !e.IsDir {
						e.Size = info.Size()
					}
				}
				local = append(local, e)
				if e.IsDir {
					subdirs = append(subdirs, filepath.Join(dir, name))
				}
			}

			mu.Lock()
			di := int32(len(ix.Dirs))
			ix.Dirs = append(ix.Dirs, dir)
			for i := range local {
				local[i].Dir = di
			}
			ix.Entries = append(ix.Entries, local...)
			queue = append(queue, subdirs...)
			pending += len(subdirs) - 1
			p.Folders.Add(1)
			p.Files.Add(int64(len(local)))
			cond.Broadcast()
			mu.Unlock()
		}
	}

	if workers < 1 {
		workers = 1
	}
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); worker() }()
	}
	wg.Wait()

	ix.Errors = int(p.Errors.Load())
	ix.Built = time.Now()
	ix.prepare()
	return ix
}

func SaveIndex(ix *Index, path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	bw := bufio.NewWriterSize(f, 1<<20)
	zw, _ := gzip.NewWriterLevel(bw, gzip.BestSpeed)
	err = gob.NewEncoder(zw).Encode(ix)
	if err == nil {
		err = zw.Close()
	}
	if err == nil {
		err = bw.Flush()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func LoadIndex(path string) (*Index, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	zr, err := gzip.NewReader(bufio.NewReaderSize(f, 1<<20))
	if err != nil {
		return nil, err
	}
	ix := &Index{}
	if err := gob.NewDecoder(zr).Decode(ix); err != nil {
		return nil, err
	}
	ix.prepare()
	return ix, nil
}

// ---------- Suche ----------

// Kategorien für den Schnellfilter.
const (
	CatAll = iota // nur als Filter: alles
	CatPDF
	CatImage
	CatOffice
	CatFolder
	CatOther
	NumCats
)

var CatNames = [NumCats]string{"Alle", "PDF", "Bilder", "Office", "Ordner", "Sonstige"}

var extCat = func() map[string]uint8 {
	m := map[string]uint8{"pdf": CatPDF}
	for _, e := range strings.Fields("jpg jpeg jpe png gif bmp tif tiff heic heif webp svg ico raw cr2 cr3 nef arw dng orf rw2 psd ai eps") {
		m[e] = CatImage
	}
	for _, e := range strings.Fields("doc docx docm dot dotx odt rtf xls xlsx xlsm xlsb xlt xltx csv ods ppt pptx pptm pps ppsx pot potx odp vsd vsdx one msg eml") {
		m[e] = CatOffice
	}
	return m
}()

func categoryOf(lowerName string, isDir bool) uint8 {
	if isDir {
		return CatFolder
	}
	if i := strings.LastIndexByte(lowerName, '.'); i >= 0 {
		if c, ok := extCat[lowerName[i+1:]]; ok {
			return c
		}
	}
	return CatOther
}

// FilterBit liefert das Bit einer Kategorie für Query.Filter.
func FilterBit(cat int) uint8 { return 1 << cat }

type Query struct {
	Text      string
	Filter    uint8 // gesetzte Bits = erlaubte Kategorien (FilterBit); 0 = alles
	InPath    bool
	MaxResult int
	Under     string // nur unterhalb dieses Ordners suchen ("" = überall)
}

type term struct {
	s    string
	glob bool
}

func parseTerms(q string) []term {
	var ts []term
	for _, f := range strings.Fields(normLower(q)) {
		ts = append(ts, term{s: f, glob: strings.ContainsAny(f, "*?")})
	}
	return ts
}

// Search liefert die Indizes passender Einträge, die Gesamtzahl im gewählten Filter und
// die Trefferzahl je Kategorie (für die Zahlen auf den Filter-Knöpfen).
// Ohne Suchbegriff werden bei gesetztem Filter alle Einträge dieser Kategorien geliefert.
func (ix *Index) Search(q Query, cancel func() bool) (res []int, total int, counts [NumCats]int) {
	ts := parseTerms(q.Text)
	if len(ts) == 0 && q.Filter == 0 {
		return nil, 0, counts
	}
	var dirOK []bool
	if q.Under != "" {
		dirOK = ix.dirsUnder(q.Under)
	}
	for i := range ix.Entries {
		if i&0xFFFF == 0 && cancel() {
			return nil, 0, counts
		}
		e := &ix.Entries[i]
		if dirOK != nil && !dirOK[e.Dir] {
			continue
		}
		if !matchTerms(ts, ix.lowerNames[i], ix.lowerDirs[e.Dir], q.InPath) {
			continue
		}
		cat := int(ix.cats[i])
		counts[cat]++
		counts[CatAll]++
		if q.Filter != 0 && q.Filter&FilterBit(cat) == 0 {
			continue
		}
		total++
		if q.MaxResult <= 0 || len(res) < q.MaxResult {
			res = append(res, i)
		}
	}
	return res, total, counts
}

// matchTerms: alle Wörter müssen im Namen (oder, wenn gewünscht, im Ordnerpfad) vorkommen.
func matchTerms(ts []term, lowerName, lowerDir string, inPath bool) bool {
	for _, t := range ts {
		if t.glob {
			if !globMatch(t.s, lowerName) {
				return false
			}
			continue
		}
		if strings.Contains(lowerName, t.s) {
			continue
		}
		if inPath && strings.Contains(lowerDir, t.s) {
			continue
		}
		return false
	}
	return true
}

// dirsUnder markiert alle Ordner des Index, die (bzw. deren Eltern) unter dir liegen.
func (ix *Index) dirsUnder(dir string) []bool {
	ld := strings.TrimRight(normLower(filepath.Clean(dir)), `\/`)
	sep := string(filepath.Separator)
	ok := make([]bool, len(ix.lowerDirs))
	for i, d := range ix.lowerDirs {
		d = strings.TrimRight(d, `\/`)
		ok[i] = d == ld || strings.HasPrefix(d, ld+sep)
	}
	return ok
}

// Covers: liegt dir innerhalb der eingelesenen Ordner?
func (ix *Index) Covers(dir string) bool {
	ld := strings.TrimRight(normLower(filepath.Clean(dir)), `\/`)
	sep := string(filepath.Separator)
	for _, r := range ix.Roots {
		lr := strings.TrimRight(normLower(filepath.Clean(r)), `\/`)
		if ld == lr || strings.HasPrefix(ld, lr+sep) {
			return true
		}
	}
	return false
}

// globMatch prüft Muster mit * und ? gegen den ganzen Namen.
func globMatch(pat, s string) bool {
	p := []rune(pat)
	r := []rune(s)
	pi, si := 0, 0
	star, mark := -1, 0
	for si < len(r) {
		if pi < len(p) && (p[pi] == '?' || p[pi] == r[si]) {
			pi++
			si++
		} else if pi < len(p) && p[pi] == '*' {
			star = pi
			mark = si
			pi++
		} else if star >= 0 {
			pi = star + 1
			mark++
			si = mark
		} else {
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}

// SortResults sortiert die Trefferliste. col: 0 Name, 1 Ordner, 2 Größe, 3 Geändert, 4 Typ.
func (ix *Index) SortResults(res []int, col int, asc bool) {
	less := func(a, b int) bool {
		ea, eb := &ix.Entries[a], &ix.Entries[b]
		switch col {
		case 1:
			if ix.lowerDirs[ea.Dir] != ix.lowerDirs[eb.Dir] {
				return naturalLess(ix.lowerDirs[ea.Dir], ix.lowerDirs[eb.Dir])
			}
		case 2:
			if ea.Size != eb.Size {
				return ea.Size < eb.Size
			}
		case 3:
			if ea.Mod != eb.Mod {
				return ea.Mod < eb.Mod
			}
		case 4:
			if ta, tb := fileExt(ix.lowerNames[a]), fileExt(ix.lowerNames[b]); ta != tb {
				return ta < tb
			}
		}
		if ix.lowerNames[a] != ix.lowerNames[b] {
			return naturalLess(ix.lowerNames[a], ix.lowerNames[b])
		}
		return naturalLess(ix.lowerDirs[ea.Dir], ix.lowerDirs[eb.Dir])
	}
	sort.SliceStable(res, func(i, j int) bool {
		// Ordner oben (wie im Explorer) – außer bei Sortierung nach Datum/Größe,
		// damit z. B. „zuletzt geändert“ wirklich die neueste Datei oben zeigt
		if di, dj := ix.Entries[res[i]].IsDir, ix.Entries[res[j]].IsDir; di != dj && foldersFirst(col) {
			return di
		}
		if asc {
			return less(res[i], res[j])
		}
		return less(res[j], res[i])
	})
}

// foldersFirst: bei Name, Ordner und Typ stehen Ordner oben.
func foldersFirst(sortKey int) bool { return sortKey == 0 || sortKey == 1 || sortKey == 4 }

// fileExt liefert die Endung ohne Punkt ("" wenn keine).
func fileExt(lowerName string) string {
	if i := strings.LastIndexByte(lowerName, '.'); i > 0 {
		return lowerName[i+1:]
	}
	return ""
}

// naturalLess sortiert wie der Windows-Explorer: "Ordner 2" vor "Ordner 10".
func naturalLess(a, b string) bool {
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ca, cb := a[i], b[j]
		if isDigit(ca) && isDigit(cb) {
			si, sj := i, j
			for i < len(a) && isDigit(a[i]) {
				i++
			}
			for j < len(b) && isDigit(b[j]) {
				j++
			}
			na := strings.TrimLeft(a[si:i], "0")
			nb := strings.TrimLeft(b[sj:j], "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		if ca != cb {
			return ca < cb
		}
		i++
		j++
	}
	return len(a)-i < len(b)-j
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// WithMoves liefert einen neuen Index, in dem verschobene Dateien/Ordner (alter → neuer
// vollständiger Pfad) bereits am neuen Ort stehen – ohne das NAS neu einzulesen.
// Der alte Index bleibt unverändert (laufende Suchen lesen ihn weiter).
func (ix *Index) WithMoves(moves map[string]string) *Index {
	if len(moves) == 0 {
		return ix
	}
	nx := *ix
	nx.Dirs = append([]string(nil), ix.Dirs...)
	nx.lowerDirs = append([]string(nil), ix.lowerDirs...)
	nx.Entries = append([]Entry(nil), ix.Entries...)
	dirIdx := make(map[string]int32, len(nx.lowerDirs))
	for i, d := range nx.lowerDirs {
		dirIdx[d] = int32(i)
	}
	getDir := func(d string) int32 {
		ld := normLower(d)
		if i, ok := dirIdx[ld]; ok {
			return i
		}
		i := int32(len(nx.Dirs))
		nx.Dirs = append(nx.Dirs, d)
		nx.lowerDirs = append(nx.lowerDirs, ld)
		dirIdx[ld] = i
		return i
	}
	type key struct {
		dir  int32
		name string
	}
	type dest struct {
		dir  int32
		name string // neuer Name (Umbenennen), sonst ""
	}
	sep := string(filepath.Separator)
	targets := map[key]dest{}
	for old, nw := range moves {
		old, nw = filepath.Clean(old), filepath.Clean(nw)
		od, ok := dirIdx[normLower(filepath.Dir(old))]
		if !ok {
			continue
		}
		d := dest{dir: getDir(filepath.Dir(nw))}
		if filepath.Base(nw) != filepath.Base(old) {
			d.name = filepath.Base(nw)
		}
		targets[key{od, normLower(filepath.Base(old))}] = d
		// war es ein Ordner: alle Pfade darunter mitziehen
		lo := normLower(old)
		for i, ld := range nx.lowerDirs {
			if ld != lo && !strings.HasPrefix(ld, lo+sep) {
				continue
			}
			rest := len(ld) - len(lo)
			orig := nx.Dirs[i]
			if rest > len(orig) {
				continue
			}
			nd := nw + orig[len(orig)-rest:]
			delete(dirIdx, ld)
			nx.Dirs[i], nx.lowerDirs[i] = nd, normLower(nd)
			dirIdx[nx.lowerDirs[i]] = int32(i)
		}
	}
	renamed := false
	for i := range nx.Entries {
		e := &nx.Entries[i]
		if t, ok := targets[key{e.Dir, ix.lowerNames[i]}]; ok {
			e.Dir = t.dir
			if t.name != "" {
				if !renamed {
					nx.lowerNames = append([]string(nil), ix.lowerNames...)
					nx.cats = append([]uint8(nil), ix.cats...)
					renamed = true
				}
				e.Name = t.name
				nx.lowerNames[i] = normLower(t.name)
				nx.cats[i] = categoryOf(nx.lowerNames[i], e.IsDir)
			}
		}
	}
	return &nx
}

// WithRemoved liefert einen neuen Index ohne die gelöschten Dateien/Ordner (samt Inhalt).
func (ix *Index) WithRemoved(paths []string) *Index {
	if len(paths) == 0 {
		return ix
	}
	sep := string(filepath.Separator)
	type key struct {
		dir  string
		name string
	}
	gone := map[key]bool{}
	var prefixes []string
	for _, p := range paths {
		p = filepath.Clean(p)
		gone[key{normLower(filepath.Dir(p)), normLower(filepath.Base(p))}] = true
		prefixes = append(prefixes, normLower(p))
	}
	deadDir := make([]bool, len(ix.lowerDirs))
	for i, d := range ix.lowerDirs {
		for _, pre := range prefixes {
			if d == pre || strings.HasPrefix(d, pre+sep) {
				deadDir[i] = true
				break
			}
		}
	}
	nx := *ix
	nx.Entries = make([]Entry, 0, len(ix.Entries))
	nx.lowerNames = make([]string, 0, len(ix.Entries))
	nx.cats = make([]uint8, 0, len(ix.Entries))
	for i := range ix.Entries {
		e := ix.Entries[i]
		if deadDir[e.Dir] || gone[key{ix.lowerDirs[e.Dir], ix.lowerNames[i]}] {
			continue
		}
		nx.Entries = append(nx.Entries, e)
		nx.lowerNames = append(nx.lowerNames, ix.lowerNames[i])
		nx.cats = append(nx.cats, ix.cats[i])
	}
	return &nx
}

// WithAdded nimmt neue Dateien/Ordner (z. B. „Neuer Ordner“, Kopien) sofort in den Index auf.
func (ix *Index) WithAdded(paths []string) *Index {
	if len(paths) == 0 {
		return ix
	}
	nx := *ix
	nx.Dirs = append([]string(nil), ix.Dirs...)
	nx.lowerDirs = append([]string(nil), ix.lowerDirs...)
	nx.Entries = append([]Entry(nil), ix.Entries...)
	nx.lowerNames = append([]string(nil), ix.lowerNames...)
	nx.cats = append([]uint8(nil), ix.cats...)
	dirIdx := make(map[string]int32, len(nx.lowerDirs))
	for i, d := range nx.lowerDirs {
		dirIdx[d] = int32(i)
	}
	type key struct {
		dir  int32
		name string
	}
	have := map[key]bool{}
	for _, p := range paths {
		p = filepath.Clean(p)
		if !ix.Covers(p) {
			continue
		}
		if len(have) == 0 {
			for i := range nx.Entries {
				have[key{nx.Entries[i].Dir, nx.lowerNames[i]}] = true
			}
		}
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		d := filepath.Dir(p)
		ld := normLower(d)
		di, ok := dirIdx[ld]
		if !ok {
			di = int32(len(nx.Dirs))
			nx.Dirs = append(nx.Dirs, d)
			nx.lowerDirs = append(nx.lowerDirs, ld)
			dirIdx[ld] = di
		}
		e := Entry{Name: fi.Name(), Dir: di, IsDir: fi.IsDir(), Mod: fi.ModTime().Unix()}
		if !e.IsDir {
			e.Size = fi.Size()
		}
		ln := normLower(e.Name)
		if have[key{di, ln}] {
			continue
		}
		have[key{di, ln}] = true
		nx.Entries = append(nx.Entries, e)
		nx.lowerNames = append(nx.lowerNames, ln)
		nx.cats = append(nx.cats, categoryOf(ln, e.IsDir))
	}
	return &nx
}

// LiveSearch durchsucht einen Ordner direkt auf dem Laufwerk (für Ordner, die nicht im Index
// stehen). Das Ergebnis ist ein kleiner Index nur mit den Treffern.
func LiveSearch(root string, q Query, excludes []string, cancel func() bool) (*Index, []int, int, [NumCats]int) {
	var counts [NumCats]int
	out := &Index{Roots: []string{root}, Built: time.Now()}
	ts := parseTerms(q.Text)
	if len(ts) == 0 && q.Filter == 0 {
		out.prepare()
		return out, nil, 0, counts
	}
	excl := map[string]bool{}
	for _, e := range excludes {
		excl[strings.ToLower(e)] = true
	}
	total := 0
	var res []int
	dirIdx := map[string]int32{}
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if depth > 40 || cancel() {
			return
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			out.Errors++
			return
		}
		ldir := normLower(dir)
		for _, de := range ents {
			name := de.Name()
			if excl[strings.ToLower(name)] {
				continue
			}
			ln := normLower(name)
			if matchTerms(ts, ln, ldir, q.InPath) {
				cat := int(categoryOf(ln, de.IsDir()))
				counts[cat]++
				counts[CatAll]++
				if q.Filter == 0 || q.Filter&FilterBit(cat) != 0 {
					total++
					if q.MaxResult <= 0 || len(res) < q.MaxResult {
						di, ok := dirIdx[ldir]
						if !ok {
							di = int32(len(out.Dirs))
							out.Dirs = append(out.Dirs, dir)
							dirIdx[ldir] = di
						}
						e := Entry{Name: name, Dir: di, IsDir: de.IsDir()}
						if info, err := de.Info(); err == nil {
							e.Mod = info.ModTime().Unix()
							if !e.IsDir {
								e.Size = info.Size()
							}
						}
						res = append(res, len(out.Entries))
						out.Entries = append(out.Entries, e)
					}
				}
			}
			if de.IsDir() {
				walk(filepath.Join(dir, name), depth+1)
			}
		}
	}
	walk(root, 0)
	out.prepare()
	return out, res, total, counts
}
