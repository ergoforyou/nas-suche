//go:build windows

package main

// Anbindung der Browser-Oberfläche an das Windows-Programm.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/lxn/walk"
	"github.com/lxn/win"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func (a *App) Index() *Index { return a.ix }
func (a *App) Cfg() *Config  { return a.cfg }

// Sync führt f im Oberflächen-Thread aus und wartet. Ist die Oberfläche gerade blockiert
// (z. B. eine Meldung ist offen), läuft f nach kurzer Zeit direkt – aber nie doppelt.
func (a *App) Sync(f func()) {
	if a.mw == nil {
		f()
		return
	}
	var once sync.Once
	done := make(chan struct{})
	run := func() { once.Do(func() { f(); close(done) }) }
	a.mw.Synchronize(run)
	select {
	case <-done:
	case <-time.After(700 * time.Millisecond):
		run()
		<-done
	}
}

func (a *App) Transfer(paths []string, target string, move bool) (map[string]string, int, error) {
	var err error
	if move {
		err = MoveFilesTo(paths, target)
	} else {
		err = CopyFilesTo(paths, target)
	}
	moves := map[string]string{}
	done := 0
	for _, s := range paths {
		dst := filepath.Join(target, filepath.Base(s))
		if _, e := os.Stat(dst); e != nil {
			continue
		}
		done++
		if move {
			if _, e := os.Stat(s); os.IsNotExist(e) {
				moves[s] = dst
			}
		}
	}
	a.Sync(func() { a.applyMoves(moves) })
	return moves, done, err
}

func (a *App) Moved(moves map[string]string) {
	a.Sync(func() { a.applyMoves(moves) })
}

// applyMoves (im Oberflächen-Thread): Index nachziehen, Ansichten auffrischen, Index speichern.
func (a *App) applyMoves(moves map[string]string) {
	if len(moves) == 0 {
		return
	}
	if a.ix != nil {
		a.ix = a.ix.WithMoves(moves)
		if !a.ixShared {
			saveIndexSoon(func() *Index { return a.ix })
		}
	}
	for _, p := range a.panes {
		p.scheduleSearch()
	}
}

func (a *App) OpenPath(p string) error { return hostOpen(p) }
func (a *App) RevealPath(p string)     { hostReveal(p) }

func (a *App) ClipboardFiles(paths []string) error {
	var err error
	a.Sync(func() { err = CopyFilesToClipboard(uintptr(a.mw.Handle()), paths) })
	return err
}

func (a *App) ShowSettings() {
	a.mw.Synchronize(func() {
		a.showWindow()
		a.showSettings()
	})
}

func (a *App) ShowWindow() { a.mw.Synchronize(a.showWindow) }

func (a *App) Reindex() {
	a.mw.Synchronize(func() {
		if !a.indexing {
			a.startIndex()
		}
	})
}

func (a *App) Indexing() bool { return a.indexing }

func (a *App) StatusText() string {
	if a.status == nil {
		return ""
	}
	return strings.TrimSpace(a.status.Text())
}

func (a *App) PCItems() []NavItem {
	var items []NavItem
	known := []struct {
		name string
		id   *windows.KNOWNFOLDERID
	}{
		{"Desktop", windows.FOLDERID_Desktop},
		{"Downloads", windows.FOLDERID_Downloads},
		{"Dokumente", windows.FOLDERID_Documents},
		{"Bilder", windows.FOLDERID_Pictures},
	}
	for _, k := range known {
		if p, err := windows.KnownFolderPath(k.id, 0); err == nil && p != "" {
			items = append(items, NavItem{Name: k.name, Path: p})
		}
	}
	mask, _ := windows.GetLogicalDrives()
	for i := 2; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		label := root[:2]
		switch windows.GetDriveType(windows.StringToUTF16Ptr(root)) {
		case windows.DRIVE_REMOTE:
			if r := CurrentConnection(root[:2]); r != "" {
				label += "  (" + r + ")"
			} else {
				label += "  (Netzlaufwerk)"
			}
		case windows.DRIVE_CDROM:
			label += "  (DVD)"
		case windows.DRIVE_REMOVABLE:
			label += "  (Wechseldatenträger)"
		default:
			label += "  (Lokaler Datenträger)"
		}
		items = append(items, NavItem{Name: label, Path: root})
	}
	return items
}

// startWeb startet die Schnittstelle für Chrome und meldet das Programm bei Chrome an.
func (a *App) startWeb() {
	if _, err := startWebServer(a); err != nil {
		dbg("Browser-Schnittstelle: %v", err)
	}
	if dir, err := writeExtension(); err != nil {
		dbg("Erweiterung ablegen: %v", err)
	} else {
		dbg("Erweiterung in %s", dir)
	}
	if !portableMode() {
		registerNativeHost()
	}
}

// registerNativeHost trägt das Programm bei Chrome und Edge als Hilfsprogramm ein
// (nur für diesen Benutzer, keine Administratorrechte nötig).
func registerNativeHost() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	manifest := filepath.Join(filepath.Dir(userConfigPath()), "chrome-hilfsprogramm.json")
	os.MkdirAll(filepath.Dir(manifest), 0o755)
	if err := os.WriteFile(manifest, nativeHostManifest(exe), 0o644); err != nil {
		return
	}
	// Chrome (liest auch Opera), Edge, Brave, Vivaldi, Opera
	for _, base := range []string{`Software\Google\Chrome\NativeMessagingHosts\`, `Software\Microsoft\Edge\NativeMessagingHosts\`,
		`Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\`, `Software\Vivaldi\NativeMessagingHosts\`,
		`Software\Opera Software\NativeMessagingHosts\`, `Software\Chromium\NativeMessagingHosts\`} {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, base+nativeHostName, registry.SET_VALUE)
		if err != nil {
			continue
		}
		k.SetStringValue("", manifest)
		k.Close()
	}
}

// setupChrome: Erweiterung ablegen und Schritt für Schritt erklären, wie man sie in Chrome lädt.
func (a *App) setupChrome(owner walk.Form) {
	dir, err := writeExtension()
	if err != nil {
		walk.MsgBox(owner, brandProduct, "Die Erweiterung konnte nicht abgelegt werden:\n"+err.Error(), walk.MsgBoxIconError)
		return
	}
	if !portableMode() {
		registerNativeHost()
	}
	walk.Clipboard().SetText(dir)
	openExplorer(dir, false)
	// Erweiterungsseite in Chrome öffnen (falls Chrome installiert ist)
	for _, c := range chromePaths() {
		if _, err := os.Stat(c); err == nil {
			exec.Command(c, "chrome://extensions/").Start()
			break
		}
	}
	walk.MsgBox(owner, brandProduct+" im Browser einrichten",
		"So kommt die NAS-Suche in den Browser (einmalig, ca. 1 Minute):\n\n"+
			"1. Die Erweiterungsseite öffnen – in Chrome ist sie schon offen, sonst eintippen:\n"+
			"   chrome://extensions  ·  edge://extensions  ·  opera://extensions  ·  brave://extensions\n"+
			"2. Oben rechts „Entwicklermodus“ einschalten.\n"+
			"3. Links oben „Entpackte Erweiterung laden“ klicken.\n"+
			"4. Den Ordner auswählen – der Pfad ist schon in der Zwischenablage (Strg+V ins Adressfeld):\n   "+dir+"\n"+
			"5. Fertig: Das ERGOFORYOU-Symbol erscheint oben rechts (über das Puzzle- bzw. Würfel-Symbol anheften).\n\n"+
			"Klick auf das Symbol öffnet die NAS-Suche als Tab, Alt+Umschalt+F von überall im Browser.\n"+
			"Das Programm muss dafür nicht geöffnet sein – der Browser startet es bei Bedarf im Hintergrund.\n"+
			"Tipp für Opera: zusätzlich „Mit Windows starten“ anhaken, dann ist die Suche immer sofort da.",
		walk.MsgBoxIconInformation)
}

func chromePaths() []string {
	var out []string
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
		if b := os.Getenv(env); b != "" {
			out = append(out, filepath.Join(b, `Google\Chrome\Application\chrome.exe`))
		}
	}
	return out
}

// ---------- Hilfsprogramm-Teil (wird von Chrome gestartet) ----------

func allowForeground() { procAllowSetForegroundWindow.Call(^uintptr(0)) } // ASFW_ANY

func allowAppForeground() {
	if pid := runningPID(); pid != 0 {
		procAllowSetForegroundWindow.Call(uintptr(pid))
	} else {
		allowForeground()
	}
}

func hostOpen(p string) error {
	allowForeground()
	if !win.ShellExecute(0, syscall.StringToUTF16Ptr("open"), syscall.StringToUTF16Ptr(p), nil, nil, win.SW_SHOWNORMAL) {
		return fmt.Errorf("„%s“ konnte nicht geöffnet werden (kein passendes Programm?)", filepath.Base(p))
	}
	return nil
}

func hostReveal(p string) {
	allowForeground()
	if st, err := os.Stat(p); err == nil && st.IsDir() {
		openExplorer(p, false)
		return
	}
	openExplorer(p, true)
}

// startAppBackground startet NasSuche im Hintergrund (Symbol neben der Uhr), losgelöst von Chrome.
func startAppBackground() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	const detached, newGroup, breakaway = 0x00000008, 0x00000200, 0x01000000
	cmd := exec.Command(exe, "/tray")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detached | newGroup | breakaway, HideWindow: true}
	if err := cmd.Start(); err != nil {
		// Chrome erlaubt das Herauslösen nicht – dann eben ohne
		cmd = exec.Command(exe, "/tray")
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detached | newGroup, HideWindow: true}
		if err := cmd.Start(); err != nil {
			return err
		}
	}
	cmd.Process.Release()
	return nil
}
