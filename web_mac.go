//go:build !windows

package main

// Mac-App ↔ Browser-Oberfläche (Chrome, Edge, Opera, Brave): Schnittstelle, Anmeldestart,
// Einrichtungshilfe, Vorgaben für Kollegen.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
)

var macWebMu sync.Mutex

func (a *MacApp) Index() *Index  { return a.ix }
func (a *MacApp) Cfg() *Config   { return a.cfg }
func (a *MacApp) Sync(f func())  { macWebMu.Lock(); defer macWebMu.Unlock(); f() }
func (a *MacApp) Indexing() bool { return a.indexing }

func (a *MacApp) Transfer(paths []string, target string, move bool) (map[string]string, int, error) {
	moves, done, err := transferFiles(paths, target, move)
	a.Moved(moves)
	return moves, done, err
}

func (a *MacApp) Moved(moves map[string]string) {
	if a.ix != nil && len(moves) > 0 {
		a.ix = a.ix.WithMoves(moves)
		saveIndexSoon(func() *Index { return a.ix })
	}
	for _, p := range a.panes {
		p.scheduleSearch()
	}
}

func (a *MacApp) OpenPath(p string) error             { return hostOpen(p) }
func (a *MacApp) RevealPath(p string)                 { hostReveal(p) }
func (a *MacApp) ClipboardFiles(paths []string) error { return copyFilesToClipboard(paths) }
func (a *MacApp) PCItems() []NavItem                  { return pcItems() }
func (a *MacApp) StatusText() string                  { return a.status.Text }

func (a *MacApp) ShowWindow() {
	a.w.Show()
	a.w.RequestFocus()
	if b := appBundle(); b != "" && runtime.GOOS == "darwin" {
		exec.Command("open", b).Start() // App nach vorne holen
	}
}

func (a *MacApp) ShowSettings() {
	a.ShowWindow()
	a.showSettings()
}

func (a *MacApp) Reindex() {
	if !a.indexing && len(a.cfg.Folders) > 0 {
		a.startIndex()
	}
}

// startWeb: Schnittstelle für die Browser-Erweiterung starten (ein laufender Hintergrunddienst
// wird abgelöst) und die Erweiterung samt Hilfsprogramm-Anmeldung bereitlegen.
func (a *MacApp) startWeb() {
	stopBackgroundService()
	startWebServer(a)
	writeExtension()
	registerNativeHost()
}

// ---------- Anmeldestart (nur der unsichtbare Dienst für den Browser) ----------

const launchAgentLabel = "de.ergoforyou.nassuche"

func launchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
}

func loginAgentEnabled() bool {
	_, err := os.Stat(launchAgentPath())
	return err == nil
}

// setLoginAgent: beim Anmelden den Hintergrunddienst starten (kein Fenster, kein Dock-Symbol) –
// dann ist die Suche im Browser sofort da, auch in Browsern ohne Startfunktion.
func setLoginAgent(on bool) error {
	p := launchAgentPath()
	if !on {
		exec.Command("launchctl", "unload", p).Run()
		err := os.Remove(p)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	esc := func(s string) string {
		return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>` + launchAgentLabel + `</string>
  <key>ProgramArguments</key><array><string>` + esc(exe) + `</string><string>--hintergrund</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
`
	os.MkdirAll(filepath.Dir(p), 0o755)
	return os.WriteFile(p, []byte(plist), 0o644)
}

// ---------- Einrichtungshilfe ----------

func (a *MacApp) setupBrowser() {
	dir, err := writeExtension()
	if err != nil {
		dialog.ShowError(fmt.Errorf("Die Erweiterung konnte nicht abgelegt werden: %v", err), a.w)
		return
	}
	registerNativeHost()
	a.w.Clipboard().SetContent(dir)
	if runtime.GOOS == "darwin" {
		exec.Command("open", dir).Start()
		for _, app := range []string{"Google Chrome", "Opera", "Microsoft Edge", "Brave Browser"} {
			if _, err := os.Stat("/Applications/" + app + ".app"); err == nil {
				exec.Command("open", "-a", app).Start()
				break
			}
		}
	}
	text := "So kommt die NAS-Suche in den Browser (einmalig, ca. 1 Minute):\n\n" +
		"1. Im Browser die Erweiterungsseite öffnen – Adresse eintippen:\n" +
		"     Chrome: chrome://extensions    Opera: opera://extensions\n" +
		"     Edge: edge://extensions        Brave: brave://extensions\n" +
		"2. „Entwicklermodus“ einschalten (Chrome/Edge/Brave oben rechts, Opera oben rechts als Schalter).\n" +
		"3. „Entpackte Erweiterung laden“ klicken.\n" +
		"4. Im Auswahlfenster ⌘⇧G drücken, ⌘V (Pfad ist in der Zwischenablage), Return, „Auswählen“:\n     " + dir + "\n" +
		"5. Das ERGOFORYOU-Symbol über das Puzzle-Symbol (Opera: Würfel-Symbol) anheften.\n\n" +
		"Klick auf das Symbol öffnet die NAS-Suche als Tab, ⌥⇧F von überall im Browser.\n" +
		"Tipp: „Beim Anmelden im Hintergrund starten“ in den Einstellungen – dann ist die Suche im Browser immer sofort da."
	l := widget.NewLabel(text)
	l.Wrapping = fyne.TextWrapWord
	d := dialog.NewCustom("NAS-Suche im Browser einrichten", "OK", l, a.w)
	d.Resize(fyne.NewSize(680, 460))
	d.Show()
}

// ---------- Vorgaben für Kollegen ----------

// exportDefaults speichert Suchordner, Freigaben, feste Ordner … als NasSuche.json.
func (a *MacApp) exportDefaults() {
	c := a.cfg
	out := &Config{Folders: c.Folders, Drives: c.Drives, Excludes: c.Excludes, RefreshHours: c.RefreshHours,
		Workers: c.Workers, Favorites: c.Favorites, StartFolder: c.StartFolder, StartFolder2: c.StartFolder2,
		SharedIndexDir: c.SharedIndexDir, Version: c.Version}
	b, _ := json.MarshalIndent(out, "", "  ")
	d := dialog.NewFileSave(func(w fyne.URIWriteCloser, err error) {
		if err != nil || w == nil {
			return
		}
		defer w.Close()
		if _, err := w.Write(b); err != nil {
			dialog.ShowError(err, a.w)
			return
		}
		dialog.ShowInformation("Vorgabe gespeichert", "Gespeichert als "+w.URI().Path()+
			"\n\nDie Datei an Kollegen weitergeben (z. B. per E-Mail). Sie wählen auf ihrem Mac in den Einstellungen\n"+
			"„Vorgabe laden …“ – danach arbeitet jeder Mac unabhängig mit eigenem Index.", a.w)
	}, a.w)
	d.SetFileName("NasSuche.json")
	d.Show()
}

// importDefaults übernimmt eine NasSuche.json (eigene Einstellungen werden ersetzt).
func (a *MacApp) importDefaults(after func()) {
	dialog.NewFileOpen(func(r fyne.URIReadCloser, err error) {
		if err != nil || r == nil {
			return
		}
		defer r.Close()
		c, err := readConfig(r.URI().Path())
		if err != nil {
			dialog.ShowError(fmt.Errorf("Datei nicht lesbar: %v", err), a.w)
			return
		}
		cur := a.cfg
		cur.Folders, cur.Drives, cur.Excludes = c.Folders, c.Drives, c.Excludes
		cur.Favorites, cur.StartFolder, cur.StartFolder2 = c.Favorites, c.StartFolder, c.StartFolder2
		if c.RefreshHours > 0 {
			cur.RefreshHours = c.RefreshHours
		}
		if c.SharedIndexDir != "" {
			cur.SharedIndexDir = c.SharedIndexDir
		}
		cur.Save()
		if after != nil {
			after()
		}
		go func() {
			a.connectAndCheck(true)
			a.startIndex()
		}()
	}, a.w).Show()
}
