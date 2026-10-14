//go:build !windows

package main

// Browser-Schnittstelle für Mac (und Linux zum Testen): ein schlanker Hintergrunddienst
// ohne eigenes Fenster. Start mit „--hintergrund“ (macht Chrome bei Bedarf selbst).

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

var buildVersion = "0"

type bgHost struct {
	mu       sync.Mutex
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
	if len(moves) > 0 {
		h.mu.Lock()
		if h.ix != nil {
			h.ix = h.ix.WithMoves(moves)
		}
		h.mu.Unlock()
	}
	return moves, done, firstErr
}

func (h *bgHost) OpenPath(p string) error { return hostOpen(p) }
func (h *bgHost) RevealPath(p string)     { hostReveal(p) }
func (h *bgHost) ClipboardFiles(paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	return copyFileToClipboard(paths[0])
}
func (h *bgHost) ShowSettings()  {}
func (h *bgHost) ShowWindow()    {}
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

func (h *bgHost) PCItems() []NavItem {
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

func startAppBackground() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
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
		dirs = []string{filepath.Join(base, "Google", "Chrome", "NativeMessagingHosts"),
			filepath.Join(base, "Microsoft Edge", "NativeMessagingHosts"),
			filepath.Join(base, "Chromium", "NativeMessagingHosts")}
	} else {
		dirs = []string{filepath.Join(home, ".config", "google-chrome", "NativeMessagingHosts"),
			filepath.Join(home, ".config", "chromium", "NativeMessagingHosts")}
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err == nil {
			os.WriteFile(filepath.Join(d, nativeHostName+".json"), nativeHostManifest(exe), 0o644)
		}
	}
}
