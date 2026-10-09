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
}

func normLower(s string) string {
	return norm.NFC.String(strings.ToLower(s))
}

func (ix *Index) prepare() {
	ix.lowerNames = make([]string, len(ix.Entries))
	for i := range ix.Entries {
		ix.lowerNames[i] = normLower(ix.Entries[i].Name)
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
				if excl[strings.ToLower(name)] || strings.HasPrefix(name, "NasSuche-Index.dat") {
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

const (
	KindAll = iota
	KindFiles
	KindFolders
)

type Query struct {
	Text      string
	Kind      int
	InPath    bool
	MaxResult int
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

// Search liefert die Indizes passender Einträge. truncated = mehr als MaxResult Treffer.
func (ix *Index) Search(q Query, cancel func() bool) (res []int, total int) {
	ts := parseTerms(q.Text)
	if len(ts) == 0 {
		return nil, 0
	}
	for i := range ix.Entries {
		if i&0xFFFF == 0 && cancel() {
			return nil, 0
		}
		e := &ix.Entries[i]
		if (q.Kind == KindFiles && e.IsDir) || (q.Kind == KindFolders && !e.IsDir) {
			continue
		}
		name := ix.lowerNames[i]
		ok := true
		for _, t := range ts {
			if t.glob {
				if !globMatch(t.s, name) {
					ok = false
					break
				}
				continue
			}
			if strings.Contains(name, t.s) {
				continue
			}
			if q.InPath && strings.Contains(ix.lowerDirs[e.Dir], t.s) {
				continue
			}
			ok = false
			break
		}
		if ok {
			total++
			if q.MaxResult <= 0 || len(res) < q.MaxResult {
				res = append(res, i)
			}
		}
	}
	return res, total
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

// SortResults sortiert Trefferliste nach Spalte.
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
		}
		if ix.lowerNames[a] != ix.lowerNames[b] {
			return naturalLess(ix.lowerNames[a], ix.lowerNames[b])
		}
		return naturalLess(ix.lowerDirs[ea.Dir], ix.lowerDirs[eb.Dir])
	}
	sort.SliceStable(res, func(i, j int) bool {
		if asc {
			return less(res[i], res[j])
		}
		return less(res[j], res[i])
	})
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
