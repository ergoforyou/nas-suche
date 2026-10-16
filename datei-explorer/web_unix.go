//go:build !windows

package main

// Browser-Schnittstelle ohne Windows (nur zum Entwickeln und Testen der Oberfläche):
// ein schlanker Hintergrunddienst ohne eigenes Fenster.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var buildVersion = "0"

type bgHost struct {
	mu       sync.Mutex
	clip     []string // eigene Zwischenablage (Dateien)
	clipCut  bool
	cfg      *Config
	ix       *Index
	indexing atomic.Bool
	stop     atomic.Bool
	status   atomic.Value
}

func (h *bgHost) Index() *Index {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ix
}
func (h *bgHost) Cfg() *Config  { return h.cfg }
func (h *bgHost) Sync(f func()) { h.mu.Lock(); defer h.mu.Unlock(); f() }

func (h *bgHost) Transfer(paths []string, target string, move bool) (map[string]string, int, error) {
	moves, done, err := transferFiles(paths, target, move)
	h.Moved(moves)
	return moves, done, err
}

// transferFiles verschiebt/kopiert (bei Namensgleichheit mit „ (2)“) und meldet, was passiert ist.
func transferFiles(paths []string, target string, move bool) (map[string]string, int, error) {
	moves := map[string]string{}
	done := 0
	var firstErr error
	for _, s := range paths {
		dst := uniquePath(filepath.Join(target, filepath.Base(s)))
		var err error
		if move {
			err = moveItem(s, dst)
			if err == nil {
				moves[s] = dst
			}
		} else {
			err = copyItem(s, dst)
		}
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		done++
	}
	return moves, done, firstErr
}

// copyFilesToClipboard legt Dateien selbst in die Zwischenablage (Einfügen im Finder, in Mail …).
func copyFilesToClipboard(paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	if runtime.GOOS != "darwin" {
		return copyFileToClipboard(paths[0])
	}
	var items []string
	for _, p := range paths {
		items = append(items, `POSIX file "`+strings.ReplaceAll(p, `"`, `\"`)+`"`)
	}
	return exec.Command("osascript", "-e", "set the clipboard to {"+strings.Join(items, ", ")+"}").Run()
}

func (h *bgHost) Moved(moves map[string]string) {
	if len(moves) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ix != nil {
		h.ix = h.ix.WithMoves(moves)
		saveIndexSoon(h.Index)
	}
}

func (h *bgHost) OpenPath(p string) error { return hostOpen(p) }
func (h *bgHost) RevealPath(p string)     { hostReveal(p) }
func (h *bgHost) ClipboardFiles(paths []string, cut bool) error {
	h.mu.Lock()
	h.clip, h.clipCut = append([]string(nil), paths...), cut
	h.mu.Unlock()
	return nil
}

func (h *bgHost) HasClipboardFiles() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.clip) > 0 }

func (h *bgHost) Paste(dir string) (string, error) {
	h.mu.Lock()
	paths, cut := h.clip, h.clipCut
	if cut {
		h.clip = nil
	}
	h.mu.Unlock()
	if len(paths) == 0 {
		return "In der Zwischenablage liegen keine Dateien.", nil
	}
	moves, done, err := h.Transfer(paths, dir, cut)
	if err != nil && done == 0 {
		return "", err
	}
	if cut {
		return fmt.Sprintf("%d Element(e) nach %s verschoben.", len(moves), dir), nil
	}
	return fmt.Sprintf("%d Element(e) nach %s kopiert.", done, dir), nil
}

func (h *bgHost) Delete(paths []string, recycle bool) ([]string, error) {
	var gone []string
	var firstErr error
	for _, p := range paths {
		if err := os.RemoveAll(p); err != nil && firstErr == nil {
			firstErr = err
		}
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			gone = append(gone, p)
		}
	}
	h.mu.Lock()
	if h.ix != nil {
		h.ix = h.ix.WithRemoved(gone)
	}
	h.mu.Unlock()
	return gone, firstErr
}

func (h *bgHost) Properties(paths []string) {}
func (h *bgHost) OpenWith(p string)         { hostOpen(p) }

func (h *bgHost) Added(paths []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ix != nil {
		h.ix = h.ix.WithAdded(paths)
	}
}

// Einstellungen/Fenster: der Hintergrunddienst hat keins – das Programm mit Fenster öffnen
// (es übernimmt dann die Verbindung zu Chrome und beendet diesen Dienst).
func (h *bgHost) ShowSettings() { openGUIApp() }
func (h *bgHost) ShowWindow()   { openGUIApp() }

// Quit: das Programm mit Fenster wurde gestartet und übernimmt.
func (h *bgHost) Quit() {
	go func() {
		time.Sleep(300 * time.Millisecond)
		os.Exit(0)
	}()
}
func (h *bgHost) Indexing() bool { return h.indexing.Load() }
func (h *bgHost) StatusText() string {
	s, _ := h.status.Load().(string)
	return s
}

func (h *bgHost) Reindex() {
	if h.indexing.Swap(true) {
		return
	}
	go func() {
		defer h.indexing.Store(false)
		h.status.Store("Lese Ordner ein …")
		p := &Progress{}
		p.Current.Store("")
		start := time.Now()
		ix := BuildIndex(h.cfg.Folders, h.cfg.Excludes, h.cfg.Workers, &h.stop, p)
		SaveIndex(ix, indexPath())
		h.mu.Lock()
		h.ix = ix
		h.mu.Unlock()
		h.status.Store("Index: " + thousands(int64(len(ix.Entries))) + " Einträge (eingelesen in " +
			time.Since(start).Round(time.Second).String() + ")")
	}()
}

func (h *bgHost) PCItems() []NavItem { return pcItems() }

func pcItems() []NavItem {
	home, _ := os.UserHomeDir()
	var items []NavItem
	for _, k := range []struct{ name, sub string }{{"Schreibtisch", "Desktop"}, {"Downloads", "Downloads"},
		{"Dokumente", "Documents"}, {"Bilder", "Pictures"}} {
		if p := filepath.Join(home, k.sub); isDirPath(p) {
			items = append(items, NavItem{Name: k.name, Path: p})
		}
	}
	if runtime.GOOS == "darwin" {
		if ents, err := os.ReadDir("/Volumes"); err == nil {
			for _, e := range ents {
				items = append(items, NavItem{Name: e.Name(), Path: filepath.Join("/Volumes", e.Name())})
			}
		}
	} else {
		items = append(items, NavItem{Name: "/", Path: "/"})
	}
	return items
}

func isDirPath(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// runBackground: Hintergrunddienst für die Browser-Oberfläche (ohne Fenster).
func runBackground() {
	h := &bgHost{cfg: LoadConfig()}
	h.status.Store("")
	if ix, err := LoadIndex(indexPath()); err == nil {
		h.ix = ix
		h.status.Store("Index: " + thousands(int64(len(ix.Entries))) + " Einträge, Stand " + ix.Built.Format("02.01.2006 15:04"))
	}
	if _, err := startWebServer(h); err != nil {
		os.Stderr.WriteString("Schnittstelle: " + err.Error() + "\n")
		os.Exit(1)
	}
	if h.ix == nil && len(h.cfg.Folders) > 0 {
		h.Reindex()
	}
	for {
		time.Sleep(time.Minute)
		ix := h.Index()
		if !h.indexing.Load() && len(h.cfg.Folders) > 0 && (ix == nil || !sameRoots(ix.Roots, h.cfg.Folders) ||
			(h.cfg.RefreshHours > 0 && time.Since(ix.Built) > time.Duration(h.cfg.RefreshHours)*time.Hour)) {
			h.Reindex()
		}
	}
}

func isBackgroundCall(args []string) bool {
	for _, a := range args {
		if a == "--hintergrund" {
			return true
		}
	}
	return false
}

// ---------- Hilfsprogramm-Teil ----------

func allowForeground()    {}
func allowAppForeground() {}

func hostOpen(p string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", p).Start()
	}
	return exec.Command("xdg-open", p).Start()
}

func hostReveal(p string) {
	if runtime.GOOS == "darwin" {
		if isDirPath(p) {
			exec.Command("open", p).Start()
		} else {
			exec.Command("open", "-R", p).Start()
		}
		return
	}
	if !isDirPath(p) {
		p = filepath.Dir(p)
	}
	exec.Command("xdg-open", p).Start()
}

// appBundle: Pfad der .app, wenn das Programm aus einem Mac-Programmpaket läuft.
func appBundle() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	d := filepath.Dir(exe) // …/X.app/Contents/MacOS
	if filepath.Base(d) == "MacOS" && filepath.Base(filepath.Dir(d)) == "Contents" &&
		strings.HasSuffix(filepath.Dir(filepath.Dir(d)), ".app") {
		return filepath.Dir(filepath.Dir(d))
	}
	return ""
}

func openGUIApp() {
	if b := appBundle(); b != "" && runtime.GOOS == "darwin" {
		exec.Command("open", b).Start()
	}
}

func startAppBackground() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// Direkt starten (nicht über „open“): sonst hielte macOS den Dienst für das laufende
	// Programm, und ein Doppelklick auf die App würde kein Fenster mehr öffnen.
	cmd := exec.Command(exe, "--hintergrund")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	cmd.Process.Release()
	return nil
}

// registerNativeHost meldet das Programm bei Chrome/Chromium an (nur dieser Benutzer).
func registerNativeHost() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	home, _ := os.UserHomeDir()
	var dirs []string
	if runtime.GOOS == "darwin" {
		base := filepath.Join(home, "Library", "Application Support")
		for _, b := range []string{"Google/Chrome", "Microsoft Edge", "Chromium", "com.operasoftware.Opera",
			"com.operasoftware.OperaGX", "BraveSoftware/Brave-Browser", "Vivaldi"} {
			dirs = append(dirs, filepath.Join(base, filepath.FromSlash(b), "NativeMessagingHosts"))
		}
	} else {
		for _, b := range []string{"google-chrome", "chromium", "microsoft-edge", "opera", "BraveSoftware/Brave-Browser", "vivaldi"} {
			dirs = append(dirs, filepath.Join(home, ".config", filepath.FromSlash(b), "NativeMessagingHosts"))
		}
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err == nil {
			os.WriteFile(filepath.Join(d, nativeHostName+".json"), nativeHostManifest(exe), 0o644)
		}
	}
}
