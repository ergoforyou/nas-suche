package main

// Browser-Oberfläche: Das Programm stellt der Chrome-Erweiterung „ERGOFORYOU Datei-Explorer“
// eine kleine Schnittstelle auf 127.0.0.1 bereit. Suche, Verschieben, Löschen und NAS-Zugriff
// erledigt weiterhin das Programm – Chrome ist nur die Oberfläche.
//
// Sicherheit: nur 127.0.0.1 (keine Firewall-Abfrage, von außen nicht erreichbar),
// nur Anfragen der eigenen Erweiterung (Origin + eigener Header), Downloads nur mit
// geheimem Schlüssel dieser Sitzung.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Feste ID der Erweiterung (aus dem Schlüssel in chrome/manifest.json).
const extensionID = "agdabmjmoaniekhkifplndkmboadlopm"

// Name des Hilfsprogramms, über das Chrome das Programm startet (Native Messaging).
const nativeHostName = "de.ergoforyou.dateiexplorer"

const webPortFirst = 47831

// pingName / apiHeader: Kennung der Schnittstelle (die NAS-Suche hat ihre eigene).
const pingName = "DateiExplorer"
const apiHeader = "X-DateiExplorer"
const webPortCount = 10

// NavItem / NavGroup: Einträge der Navigationsleiste (Schnellzugriff, Netzlaufwerke, Dieser PC).
type NavItem struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type NavGroup struct {
	ID    string    `json:"id"`
	Name  string    `json:"name"`
	Items []NavItem `json:"items"`
}

// WebHost: was das Programm (Windows bzw. Mac) der Browser-Oberfläche zur Verfügung stellt.
type WebHost interface {
	Index() *Index
	Cfg() *Config
	// Sync führt f im Programm aus (Windows: im Oberflächen-Thread) und wartet darauf.
	Sync(f func())
	// Transfer verschiebt/kopiert und liefert, was tatsächlich passiert ist.
	Transfer(paths []string, target string, move bool) (moves map[string]string, done int, err error)
	OpenPath(p string) error
	RevealPath(p string)
	ClipboardFiles(paths []string, cut bool) error
	HasClipboardFiles() bool
	// Paste fügt Dateien aus der Zwischenablage in dir ein (auch aus dem Windows-Explorer kopierte).
	Paste(dir string) (string, error)
	// Delete löscht (recycle = Papierkorb) und liefert, was tatsächlich weg ist.
	Delete(paths []string, recycle bool) ([]string, error)
	Properties(paths []string)
	OpenWith(p string)
	// Added: neue Dateien/Ordner im Index ergänzen.
	Added(paths []string)
	ShowSettings()
	ShowWindow()
	Reindex()
	Indexing() bool
	StatusText() string
	PCItems() []NavItem // „Dieser PC“: persönliche Ordner und Laufwerke
	// Moved: Dateien wurden verschoben/umbenannt (alt → neu) – Index und Ansichten nachziehen.
	Moved(moves map[string]string)
}

type webServer struct {
	host   WebHost
	port   int
	secret string // für Download-Adressen dieser Sitzung
	mu     sync.Mutex
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func webPortFile() string { return filepath.Join(os.TempDir(), "ERGOFORYOU-DateiExplorer-web.txt") }

// readWebPort liefert den Port der laufenden Browser-Schnittstelle (0 = unbekannt).
func readWebPort() int {
	b, err := os.ReadFile(webPortFile())
	if err != nil {
		return 0
	}
	p, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return p
}

// startWebServer startet die Schnittstelle im Hintergrund. Fehler sind nicht schlimm –
// dann gibt es eben keine Browser-Oberfläche.
func startWebServer(h WebHost) (*webServer, error) {
	s := &webServer{host: h, secret: randomHex(16)}
	var ln net.Listener
	var err error
	for p := webPortFirst; p < webPortFirst+webPortCount; p++ {
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			s.port = p
			break
		}
	}
	if ln == nil {
		return nil, err
	}
	os.WriteFile(webPortFile(), []byte(strconv.Itoa(s.port)), 0o644)
	srv := &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	return s, nil
}

func allowedOrigin(o string) bool {
	if o == "chrome-extension://"+extensionID {
		return true
	}
	// zusätzliche IDs (z. B. aus dem Chrome Web Store) per Umgebungsvariable erlauben
	for _, id := range strings.Fields(strings.ReplaceAll(os.Getenv("DATEIEXPLORER_ERWEITERUNG"), ",", " ")) {
		if o == "chrome-extension://"+id {
			return true
		}
	}
	return false
}

func (s *webServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Schutz gegen DNS-Rebinding: nur direkte Aufrufe an 127.0.0.1/localhost
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if host != "127.0.0.1" && host != "localhost" {
		http.Error(w, "nicht erlaubt", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/ping" {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, pingName+" "+buildVersion)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/dl/") {
		s.download(w, r)
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}
	origin := r.Header.Get("Origin")
	if r.Method == http.MethodOptions && allowedOrigin(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, "+apiHeader)
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Eigener Header: Webseiten können ihn nur nach einer Vorab-Anfrage (OPTIONS) senden,
	// die nur für die eigene Erweiterung erlaubt wird. Chrome lässt bei Erweiterungen den
	// Origin-Header manchmal weg – ein fremder Origin wird aber immer abgewiesen.
	if (origin != "" && !allowedOrigin(origin)) || r.Header.Get(apiHeader) != "1" {
		http.Error(w, "nicht erlaubt", http.StatusForbidden)
		return
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	w.Header().Set("Cache-Control", "no-store")
	defer func() {
		if e := recover(); e != nil {
			writeJSON(w, map[string]any{"error": fmt.Sprint(e)})
		}
	}()
	switch strings.TrimPrefix(r.URL.Path, "/api/") {
	case "hello":
		s.hello(w)
	case "search":
		s.search(w, r)
	case "list":
		s.list(w, r)
	case "subdirs":
		s.subdirs(w, r)
	case "nav":
		s.nav(w)
	case "transfer":
		s.transfer(w, r)
	case "open":
		s.open(w, r)
	case "reveal":
		var req struct{ Path string }
		readJSON(r, &req)
		s.host.RevealPath(req.Path)
		writeJSON(w, map[string]any{"ok": true})
	case "clipboard":
		var req struct {
			Paths []string
			Cut   bool
		}
		readJSON(r, &req)
		err := s.host.ClipboardFiles(req.Paths, req.Cut)
		writeJSON(w, map[string]any{"ok": err == nil, "error": errText(err)})
	case "clipcheck":
		writeJSON(w, map[string]any{"files": s.host.HasClipboardFiles()})
	case "paste":
		var req struct{ Dir string }
		readJSON(r, &req)
		if st, err := os.Stat(req.Dir); err != nil || !st.IsDir() {
			writeJSON(w, map[string]any{"error": "Zielordner nicht erreichbar: " + req.Dir})
			return
		}
		msg, err := s.host.Paste(req.Dir)
		writeJSON(w, map[string]any{"ok": err == nil, "message": msg, "error": errText(err)})
	case "delete":
		var req struct {
			Paths   []string
			Recycle bool
		}
		readJSON(r, &req)
		gone, err := s.host.Delete(req.Paths, req.Recycle)
		if gone == nil {
			gone = []string{}
		}
		writeJSON(w, map[string]any{"gone": gone, "error": errText(err)})
	case "properties":
		var req struct{ Paths []string }
		readJSON(r, &req)
		s.host.Properties(req.Paths)
		writeJSON(w, map[string]any{"ok": true})
	case "openwith":
		var req struct{ Path string }
		readJSON(r, &req)
		s.host.OpenWith(req.Path)
		writeJSON(w, map[string]any{"ok": true})
	case "newfile":
		s.newFile(w, r)
	case "hidden":
		var req struct{ Show bool }
		readJSON(r, &req)
		s.host.Sync(func() { s.host.Cfg().ShowHidden = req.Show; s.host.Cfg().Save() })
		writeJSON(w, map[string]any{"ok": true})
	case "favorite":
		s.favorite(w, r)
	case "copytarget":
		var req struct{ Path string }
		readJSON(r, &req)
		s.host.Sync(func() { s.host.Cfg().addCopyTarget(req.Path); s.host.Cfg().Save() })
		writeJSON(w, map[string]any{"ok": true})
	case "startfolder":
		var req struct {
			Pane int
			Path string
		}
		readJSON(r, &req)
		s.host.Sync(func() {
			c := s.host.Cfg()
			if req.Pane == 1 {
				c.StartFolder2 = req.Path
			} else {
				c.StartFolder = req.Path
			}
			c.Save()
		})
		writeJSON(w, map[string]any{"ok": true})
	case "state":
		s.state(w, r)
	case "settings":
		s.host.ShowSettings()
		writeJSON(w, map[string]any{"ok": true})
	case "window":
		s.host.ShowWindow()
		writeJSON(w, map[string]any{"ok": true})
	case "reindex":
		s.host.Reindex()
		writeJSON(w, map[string]any{"ok": true})
	case "upload":
		s.upload(w, r)
	case "mkdir":
		s.mkdir(w, r)
	case "rename":
		var req struct{ Path, Name string }
		readJSON(r, &req)
		dst, err := renamePath(req.Path, req.Name)
		if err == nil && dst != req.Path {
			s.host.Moved(map[string]string{req.Path: dst})
		}
		writeJSON(w, map[string]any{"ok": err == nil, "path": dst, "error": errText(err)})
	case "quit":
		// nur der Hintergrunddienst lässt sich beenden (das Programm mit Fenster übernimmt)
		if q, ok := s.host.(interface{ Quit() }); ok {
			writeJSON(w, map[string]any{"ok": true})
			q.Quit()
			return
		}
		writeJSON(w, map[string]any{"ok": false})
	default:
		http.NotFound(w, r)
	}
}

var (
	saveMu    sync.Mutex
	saveTimer *time.Timer
)

// saveIndexSoon speichert den Index kurz nach Verschieben/Umbenennen (gebündelt), damit die
// Änderungen auch nach einem Neustart sofort gefunden werden.
func saveIndexSoon(get func() *Index) {
	saveMu.Lock()
	defer saveMu.Unlock()
	if saveTimer != nil {
		saveTimer.Stop()
	}
	saveTimer = time.AfterFunc(5*time.Second, func() {
		if ix := get(); ix != nil {
			SaveIndex(ix, indexPath())
		}
	})
}

func isBackground(h WebHost) bool {
	_, ok := h.(interface{ Quit() })
	return ok
}

// stopBackgroundService beendet einen laufenden Hintergrunddienst (ohne Fenster), damit das
// Programm mit Fenster die Verbindung zu Chrome übernehmen kann.
func stopBackgroundService() {
	p := readWebPort()
	if !pingPort(p) {
		return
	}
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/api/quit", p), strings.NewReader("{}"))
	req.Header.Set(apiHeader, "1")
	c := http.Client{Timeout: 2 * time.Second}
	if r, err := c.Do(req); err == nil {
		r.Body.Close()
		time.Sleep(500 * time.Millisecond)
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(v)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func (s *webServer) dlURL(p string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/dl/%s/%s", s.port, s.secret, url.PathEscape(p))
}

func (s *webServer) hello(w http.ResponseWriter) {
	var resp map[string]any
	s.host.Sync(func() {
		c := s.host.Cfg()
		resp = map[string]any{
			"version":     buildVersion,
			"versionText": versionText(),
			"stage":       appStage,
			"brand":       brandName,
			"product":     brandProduct,
			"slogan":      brandSlogan,
			"portable":    portableMode(),
			"status":      s.host.StatusText(),
			"indexing":    s.host.Indexing(),
			"dl":          fmt.Sprintf("http://127.0.0.1:%d/dl/%s/", s.port, s.secret),
			"copyTargets": c.CopyTargets,
			"favorites":   c.Favorites,
			"folders":     c.Folders,
			"start":       []string{c.StartFolder, c.StartFolder2},
			"sep":         string(os.PathSeparator),
			"showHidden":  c.ShowHidden,
			"scope":       c.SearchScope,
			"background":  isBackground(s.host),
		}
	})
	writeJSON(w, resp)
}

// Zeile einer Trefferliste: [Name, Ordner, Ordner?, Größe, Geändert, Kategorie]
func entryRow(name, dir string, isDir bool, size, mod int64) []any {
	d := 0
	if isDir {
		d = 1
	}
	return []any{name, dir, d, size, mod, categoryOf(normLower(name), isDir)}
}

func (s *webServer) search(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Text   string
		Filter uint8
		InPath bool
		Sort   int // 0 Name, 1 Ordner, 2 Größe, 3 Geändert, 4 Typ
		Desc   bool
		Max    int
		Under  string // nur in diesem Ordner (und darunter) suchen
	}
	readJSON(r, &q)
	ix := s.host.Index()
	start := time.Now()
	if q.Max <= 0 || q.Max > 20000 {
		q.Max = 20000
	}
	// Ordner außerhalb der Suchordner: direkt auf dem Laufwerk durchsuchen
	if q.Under != "" && (ix == nil || !ix.Covers(q.Under)) {
		lix, res, total, counts := LiveSearch(q.Under, Query{Text: q.Text, Filter: q.Filter, InPath: q.InPath, MaxResult: q.Max},
			s.host.Cfg().Excludes, func() bool { return r.Context().Err() != nil })
		lix.SortResults(res, q.Sort, !q.Desc)
		rows := make([]any, 0, len(res))
		for _, i := range res {
			e := &lix.Entries[i]
			rows = append(rows, entryRow(e.Name, lix.Dirs[e.Dir], e.IsDir, e.Size, e.Mod))
		}
		writeJSON(w, map[string]any{"total": total, "counts": counts, "rows": rows, "live": true,
			"ms": time.Since(start).Milliseconds()})
		return
	}
	if ix == nil {
		writeJSON(w, map[string]any{"total": 0, "counts": []int{0, 0, 0, 0, 0, 0}, "rows": []any{}, "noindex": true})
		return
	}
	res, total, counts := ix.Search(Query{Text: q.Text, Filter: q.Filter, InPath: q.InPath, Under: q.Under}, func() bool { return false })
	ix.SortResults(res, q.Sort, !q.Desc)
	if len(res) > q.Max {
		res = res[:q.Max]
	}
	rows := make([]any, 0, len(res))
	for _, i := range res {
		e := &ix.Entries[i]
		rows = append(rows, entryRow(e.Name, ix.Dirs[e.Dir], e.IsDir, e.Size, e.Mod))
	}
	writeJSON(w, map[string]any{"total": total, "counts": counts, "rows": rows,
		"ms": time.Since(start).Milliseconds(), "entries": len(ix.Entries)})
}

// list: Inhalt eines Ordners (live vom Laufwerk), Ordner zuerst.
func (s *webServer) list(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("dir")
	ents, err := os.ReadDir(dir)
	if err != nil {
		writeJSON(w, map[string]any{"dir": dir, "error": "Ordner nicht lesbar: " + err.Error(), "rows": []any{}})
		return
	}
	rows := make([]any, 0, len(ents))
	type item struct {
		name  string
		isDir bool
		size  int64
		mod   int64
	}
	var items []item
	showHidden := false
	s.host.Sync(func() { showHidden = s.host.Cfg().ShowHidden })
	for _, de := range ents {
		n := de.Name()
		if strings.HasPrefix(n, "._") || n == ".DS_Store" || (!showHidden && hiddenEntry(de)) {
			continue
		}
		it := item{name: n, isDir: de.IsDir()}
		if info, err := de.Info(); err == nil {
			it.mod = info.ModTime().Unix()
			if !it.isDir {
				it.size = info.Size()
			}
		}
		items = append(items, it)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].isDir != items[j].isDir {
			return items[i].isDir
		}
		return naturalLess(normLower(items[i].name), normLower(items[j].name))
	})
	for _, it := range items {
		rows = append(rows, entryRow(it.name, dir, it.isDir, it.size, it.mod))
	}
	parent := filepath.Dir(dir)
	if parent == dir {
		parent = ""
	}
	writeJSON(w, map[string]any{"dir": dir, "parent": parent, "rows": rows})
}

// subdirs: nur die Unterordner (für Navigationsbaum, Pfadleiste, aufspringende Ordner).
func (s *webServer) subdirs(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("dir")
	ents, err := os.ReadDir(dir)
	var names []string
	for _, de := range ents {
		if de.IsDir() && !excludedName(s.host.Cfg(), de.Name()) {
			names = append(names, de.Name())
		}
	}
	sort.Slice(names, func(i, j int) bool { return naturalLess(normLower(names[i]), normLower(names[j])) })
	if names == nil {
		names = []string{}
	}
	writeJSON(w, map[string]any{"dir": dir, "dirs": names, "error": errText(err)})
}

func excludedName(c *Config, n string) bool {
	if strings.HasPrefix(n, ".") && n != "." {
		return true
	}
	for _, e := range c.Excludes {
		if strings.EqualFold(e, n) {
			return true
		}
	}
	return false
}

func (s *webServer) nav(w http.ResponseWriter) {
	var groups []NavGroup
	s.host.Sync(func() {
		c := s.host.Cfg()
		q := NavGroup{ID: "quick", Name: "Schnellzugriff", Items: []NavItem{}}
		for _, f := range c.Favorites {
			q.Items = append(q.Items, NavItem{Name: f.Name, Path: f.Path})
		}
		n := NavGroup{ID: "net", Name: "Netzlaufwerke", Items: []NavItem{}}
		seen := map[string]bool{}
		add := func(label, path string) {
			key := strings.ToLower(strings.TrimRight(path, `\/`))
			if path == "" || seen[key] {
				return
			}
			seen[key] = true
			n.Items = append(n.Items, NavItem{Name: label, Path: path})
		}
		for _, d := range c.Drives {
			if d.Letter != "" {
				add(d.Letter+"  ("+d.Remote+")", d.Letter+`\`)
			} else if !strings.HasPrefix(strings.ToLower(d.Remote), "smb://") {
				add(d.Remote, d.Remote)
			}
		}
		for _, f := range c.Folders {
			add(f, f)
		}
		groups = []NavGroup{q, n}
	})
	pc := NavGroup{ID: "pc", Name: "Dieser PC", Items: s.host.PCItems()}
	if pc.Items == nil {
		pc.Items = []NavItem{}
	}
	groups = append(groups, pc)
	writeJSON(w, map[string]any{"groups": groups})
}

func (s *webServer) transfer(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Paths  []string
		Target string
		Move   bool
	}
	readJSON(r, &req)
	if req.Target == "" || len(req.Paths) == 0 {
		writeJSON(w, map[string]any{"error": "Kein Ziel"})
		return
	}
	if st, err := os.Stat(req.Target); err != nil || !st.IsDir() {
		writeJSON(w, map[string]any{"error": "Zielordner nicht erreichbar: " + req.Target})
		return
	}
	var todo []string
	for _, p := range req.Paths {
		if strings.EqualFold(filepath.Dir(p), req.Target) || strings.EqualFold(p, req.Target) ||
			strings.HasPrefix(strings.ToLower(req.Target), strings.ToLower(p)+string(os.PathSeparator)) {
			continue
		}
		todo = append(todo, p)
	}
	if len(todo) == 0 {
		writeJSON(w, map[string]any{"done": 0, "message": "Liegt schon dort – nichts zu tun."})
		return
	}
	moves, done, err := s.host.Transfer(todo, req.Target, req.Move)
	verb := map[bool]string{true: "verschoben", false: "kopiert"}[req.Move]
	msg := fmt.Sprintf("%d Element(e) nach %s %s.", done, req.Target, verb)
	if err != nil && done == 0 {
		msg = err.Error()
	}
	writeJSON(w, map[string]any{"done": done, "moves": moves, "message": msg})
}

func (s *webServer) open(w http.ResponseWriter, r *http.Request) {
	var req struct{ Paths []string }
	readJSON(r, &req)
	var errs []string
	for _, p := range req.Paths {
		if _, err := os.Stat(p); err != nil {
			errs = append(errs, "Nicht mehr vorhanden oder kein Zugriff: "+p)
			continue
		}
		if err := s.host.OpenPath(p); err != nil {
			errs = append(errs, err.Error())
		}
	}
	writeJSON(w, map[string]any{"ok": len(errs) == 0, "error": strings.Join(errs, "\n")})
}

func (s *webServer) favorite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Action string // add, remove
		Name   string
		Path   string
	}
	readJSON(r, &req)
	s.host.Sync(func() {
		c := s.host.Cfg()
		var out []Favorite
		for _, f := range c.Favorites {
			if !strings.EqualFold(f.Path, req.Path) {
				out = append(out, f)
			}
		}
		if req.Action == "add" {
			name := strings.TrimSpace(req.Name)
			if name == "" {
				name = filepath.Base(req.Path)
			}
			out = append(out, Favorite{Name: name, Path: req.Path})
		}
		c.Favorites = out
		c.Save()
	})
	writeJSON(w, map[string]any{"ok": true})
}

// state: Ansicht der Browser-Oberfläche (Haken, Sortierung, zweite Ansicht …) dauerhaft merken.
func (s *webServer) state(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if json.Valid(b) {
			s.host.Sync(func() { s.host.Cfg().WebState = json.RawMessage(b); s.host.Cfg().Save() })
		}
		writeJSON(w, map[string]any{"ok": true})
		return
	}
	var st json.RawMessage
	s.host.Sync(func() { st = s.host.Cfg().WebState })
	if len(st) == 0 {
		st = json.RawMessage("{}")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(st)
}

// uniquePath hängt bei Namensgleichheit „ (2)“, „ (3)“ … an, statt zu überschreiben.
func uniquePath(p string) string {
	if _, err := os.Lstat(p); err != nil {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Lstat(c); err != nil {
			return c
		}
	}
}

// upload: Dateien, die aus dem Explorer oder einer Webseite in die Oberfläche gezogen werden.
func (s *webServer) upload(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("dir")
	name := filepath.Base(strings.ReplaceAll(r.URL.Query().Get("name"), `\`, "/"))
	if name == "" || name == "." || name == "/" || strings.ContainsAny(name, `<>:"|?*`) {
		writeJSON(w, map[string]any{"error": "Ungültiger Dateiname: " + name})
		return
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		writeJSON(w, map[string]any{"error": "Zielordner nicht erreichbar: " + dir})
		return
	}
	dst := uniquePath(filepath.Join(dir, name))
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		writeJSON(w, map[string]any{"error": err.Error()})
		return
	}
	_, err = io.Copy(f, r.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dst)
		writeJSON(w, map[string]any{"error": "Speichern fehlgeschlagen: " + err.Error()})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "path": dst})
}

// newFile legt ein leeres Dokument an (z. B. „Neues Textdokument.txt“).
func (s *webServer) newFile(w http.ResponseWriter, r *http.Request) {
	var req struct{ Dir, Name string }
	readJSON(r, &req)
	name := strings.TrimSpace(req.Name)
	if err := validName(name); err != nil {
		writeJSON(w, map[string]any{"error": err.Error()})
		return
	}
	p := uniquePath(filepath.Join(req.Dir, name))
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err == nil {
		f.Close()
		s.host.Added([]string{p})
	}
	writeJSON(w, map[string]any{"ok": err == nil, "path": p, "error": errText(err)})
}

func (s *webServer) mkdir(w http.ResponseWriter, r *http.Request) {
	var req struct{ Dir, Name string }
	readJSON(r, &req)
	name := strings.TrimSpace(req.Name)
	if name == "" || strings.ContainsAny(name, `\/<>:"|?*`) {
		writeJSON(w, map[string]any{"error": "Ungültiger Ordnername"})
		return
	}
	p := filepath.Join(req.Dir, name)
	if _, err := os.Stat(p); err == nil {
		writeJSON(w, map[string]any{"error": "„" + name + "“ gibt es dort schon."})
		return
	}
	err := os.Mkdir(p, 0o755)
	if err == nil {
		s.host.Added([]string{p})
	}
	writeJSON(w, map[string]any{"ok": err == nil, "path": p, "error": errText(err)})
}

// validName prüft einen Datei-/Ordnernamen nach den Regeln von Windows und dem NAS.
func validName(name string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("Bitte einen Namen eingeben.")
	}
	if strings.ContainsAny(name, `\/:*?"<>|`) {
		return fmt.Errorf("Ein Name darf diese Zeichen nicht enthalten: \\ / : * ? \" < > |")
	}
	for _, r := range name {
		if r < 32 {
			return fmt.Errorf("Der Name enthält ein ungültiges Zeichen.")
		}
	}
	if strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return fmt.Errorf("Ein Name darf nicht mit Punkt oder Leerzeichen enden.")
	}
	base := strings.ToUpper(strings.TrimSuffix(name, filepath.Ext(name)))
	switch base {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return fmt.Errorf("„%s“ ist unter Windows als Name nicht erlaubt.", name)
	}
	if len(name) > 240 {
		return fmt.Errorf("Der Name ist zu lang.")
	}
	return nil
}

// renamePath benennt eine Datei oder einen Ordner um und liefert den neuen Pfad.
func renamePath(src, name string) (string, error) {
	name = strings.TrimLeft(name, " ")
	if err := validName(name); err != nil {
		return src, err
	}
	if _, err := os.Lstat(src); err != nil {
		return src, fmt.Errorf("„%s“ gibt es nicht mehr (Index aktualisieren).", filepath.Base(src))
	}
	dst := filepath.Join(filepath.Dir(src), name)
	if dst == src {
		return src, nil
	}
	// nur Groß-/Kleinschreibung geändert: auf Windows/NAS dieselbe Datei – direkt umbenennen
	if !strings.EqualFold(dst, src) {
		if _, err := os.Lstat(dst); err == nil {
			return src, fmt.Errorf("Es gibt dort schon „%s“.", name)
		}
	}
	if err := os.Rename(src, dst); err != nil {
		return src, fmt.Errorf("Umbenennen nicht möglich: %v", err)
	}
	return dst, nil
}

// download: Datei für Chrome (Herausziehen auf den Desktop/Explorer, Übergabe an Webseiten).
func (s *webServer) download(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.EscapedPath(), "/dl/")
	i := strings.Index(rest, "/")
	if i < 0 || rest[:i] != s.secret {
		http.Error(w, "nicht erlaubt", http.StatusForbidden)
		return
	}
	p, err := url.PathUnescape(rest[i+1:])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.Error(w, "Datei nicht lesbar", http.StatusNotFound)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.Error(w, "keine Datei", http.StatusNotFound)
		return
	}
	if o := r.Header.Get("Origin"); allowedOrigin(o) {
		w.Header().Set("Access-Control-Allow-Origin", o)
	}
	ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(p)))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(p)}))
	http.ServeContent(w, r, filepath.Base(p), st.ModTime(), f)
}
