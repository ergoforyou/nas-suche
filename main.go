//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
	"github.com/lxn/win"
)

const maxResults = 100000

type App struct {
	mw        *walk.MainWindow
	header    *walk.CustomWidget
	banner    *banner
	panes     [2]*Pane
	nav       *Navigator
	lastPane  *Pane // zuletzt benutzte Ansicht (Ziel für Klicks im Navigationsbaum)
	secondBt  *walk.PushButton
	navBt     *walk.PushButton
	refreshBt *walk.PushButton
	status    *walk.StatusBarItem
	icon      *walk.Icon
	tray      *walk.NotifyIcon

	cfg      *Config
	ix       *Index
	ixShared bool // aktueller Index stammt vom NAS

	indexing   bool
	stopIndex  atomic.Bool
	lastInfo   string
	quitting   bool
	startTray  bool
	stopHotkey func()
	hotkeyErr  string
	gdrive     string // erkannter Google-Drive-Ordner

	stickyUntil time.Time // bis dahin überschreiben die Ansichten die Statuszeile nicht
	dragSource  bool      // gerade werden Dateien aus dem Programm gezogen
}

func main() {
	if isNativeHostCall(os.Args[1:]) {
		runNativeHost() // von Chrome gestartet
		return
	}
	app := &App{cfg: LoadConfig()}
	app.panes = [2]*Pane{newPane(app, 0), newPane(app, 1)}
	app.nav = newNavigator(app)
	for _, arg := range os.Args[1:] {
		if strings.EqualFold(arg, "/tray") || strings.EqualFold(arg, "-tray") {
			app.startTray = true
		}
	}
	clearDownloadMark()
	first, notify := SingleInstance(func() {
		if app.mw != nil {
			app.mw.Synchronize(app.showWindow)
		}
	}, func() {
		// eine neuere Version übernimmt: sauber beenden (Einstellungen sind schon gespeichert)
		if app.mw != nil {
			app.mw.Synchronize(app.quit)
		} else {
			os.Exit(0)
		}
	})
	if !first {
		if !app.startTray {
			notify()
		}
		return
	}
	app.run()
}

func (a *App) run() {
	win.OleInitialize()
	defer win.OleUninitialize()

	if ic, err := walk.NewIconFromResourceId(1); err == nil {
		a.icon = ic
	} else if ic, err := walk.NewIconFromResource("APP"); err == nil {
		a.icon = ic
	}
	a.banner = newBanner()
	a.updateBannerHint()

	grey := walk.RGB(0x60, 0x6B, 0x78)
	err := MainWindow{
		AssignTo: &a.mw,
		Title:    windowTitle(),
		Icon:     a.icon,
		Visible:  !a.startTray,
		MinSize:  Size{Width: 760, Height: 420},
		Size:     Size{Width: 1180, Height: 740},
		Layout:   VBox{MarginsZero: true, SpacingZero: true},
		Children: []Widget{
			CustomWidget{
				AssignTo:            &a.header,
				StretchFactor:       1,
				Alignment:           AlignHNearVNear,
				MinSize:             Size{Height: 62},
				MaxSize:             Size{Height: 62},
				InvalidatesOnResize: true,
				PaintMode:           PaintNoErase,
				Paint:               a.banner.paint(&a.header),
			},
			Composite{
				StretchFactor: 1000,
				Layout:        VBox{Margins: Margins{Left: 9, Top: 6, Right: 9, Bottom: 4}, Spacing: 4},
				Children: []Widget{
					Composite{
						Layout:  HBox{MarginsZero: true},
						MaxSize: Size{Height: 30},
						Children: []Widget{
							HSpacer{},
							PushButton{AssignTo: &a.navBt, MinSize: Size{Width: 170}, Text: "Navigation ausblenden", OnClicked: func() { a.setNavVisible(a.cfg.HideNav) }},
							PushButton{AssignTo: &a.secondBt, MinSize: Size{Width: 170}, Text: "Zweite Ansicht einblenden", OnClicked: func() { a.setSecondPane(!a.cfg.SecondPane) }},
							PushButton{AssignTo: &a.refreshBt, Text: "Aktualisieren (F5)", OnClicked: a.toggleIndex},
							PushButton{Text: "Einstellungen …", OnClicked: a.showSettings},
						},
					},
					Composite{
						StretchFactor: 1000,
						Layout:        HBox{MarginsZero: true, Spacing: 10},
						Children: []Widget{
							TreeView{AssignTo: &a.nav.tv, MinSize: Size{Width: 190}, MaxSize: Size{Width: 270}},
							a.panes[0].widget(), a.panes[1].widget(),
						},
					},
					Label{
						Text:      "Tipp: Treffer mit der Maus herausziehen – in den Explorer, Outlook, Google Drive oder Claude im Browser. Doppelklick auf einen Ordner zeigt seinen Inhalt. Zwischen den Ansichten ziehen = verschieben (Strg = kopieren).",
						TextColor: grey,
					},
				},
			},
		},
		StatusBarItems: []StatusBarItem{{AssignTo: &a.status, Width: 1100}},
	}.Create()
	if err != nil {
		walk.MsgBox(nil, brandProduct, "Fehler beim Start: "+err.Error(), walk.MsgBoxIconError)
		return
	}

	shortcut := func(key walk.Key, f func()) {
		act := walk.NewAction()
		act.SetShortcut(walk.Shortcut{Key: key})
		act.Triggered().Attach(f)
		a.mw.ShortcutActions().Add(act)
	}
	shortcut(walk.KeyF5, a.toggleIndex)
	shortcut(walk.KeyEscape, func() {
		// Esc: erst Suchfeld der aktiven Hälfte leeren, beim zweiten Mal Fenster ausblenden
		p := a.activePane()
		if p.search.Text() != "" {
			p.search.SetText("")
			p.search.SetFocus()
		} else if a.tray != nil {
			a.mw.Hide()
		}
	})
	for _, p := range a.panes {
		p.init()
	}
	a.nav.init()
	a.setNavVisible(!a.cfg.HideNav)
	a.setSecondPane(a.cfg.SecondPane)
	a.setupTray()
	a.applyHotkey()

	a.setStatus("Lade Index …")
	a.startWeb()
	go a.startup()
	a.panes[0].search.SetFocus()
	a.mw.Run()
	a.stopIndex.Store(true)
	if a.stopHotkey != nil {
		a.stopHotkey()
	}
	if a.tray != nil {
		a.tray.Dispose()
	}
}

func (a *App) setStatus(s string) { a.status.SetText(" " + s) }

func (a *App) updateBannerHint() {
	switch {
	case a.hotkeyErr != "":
		a.banner.hintText = a.hotkeyErr
	case a.cfg.Hotkey != "" && a.cfg.Hotkey != "Keine":
		a.banner.hintText = a.cfg.Hotkey + " öffnet die Suche jederzeit"
	default:
		a.banner.hintText = ""
	}
	if a.header != nil {
		a.header.Invalidate()
	}
}

// ---------- Hintergrundbetrieb ----------

func (a *App) setupTray() {
	ni, err := walk.NewNotifyIcon(a.mw)
	if err != nil {
		return // ohne Infobereich: Schließen beendet das Programm
	}
	a.tray = ni
	if a.icon != nil {
		ni.SetIcon(a.icon)
	}
	ni.SetToolTip(brandName + " " + brandProduct)
	ni.MouseDown().Attach(func(x, y int, b walk.MouseButton) {
		dbg("tray click %v", b)
		if b == walk.LeftButton {
			a.showWindow()
		}
	})
	add := func(text string, f func()) {
		act := walk.NewAction()
		act.SetText(text)
		act.Triggered().Attach(f)
		ni.ContextMenu().Actions().Add(act)
	}
	add("Suche öffnen", a.showWindow)
	add("Index aktualisieren", a.toggleIndex)
	add("Einstellungen …", func() { a.showWindow(); a.showSettings() })
	add("In Chrome einrichten …", func() { a.setupChrome(a.mw) })
	ni.ContextMenu().Actions().Add(walk.NewSeparatorAction())
	add("Beenden", a.quit)
	if err := ni.SetVisible(true); err != nil {
		ni.Dispose()
		a.tray = nil
		return
	}

	a.mw.Closing().Attach(func(canceled *bool, _ walk.CloseReason) {
		if a.quitting || a.tray == nil {
			return
		}
		*canceled = true
		a.mw.Hide()
		if !a.cfg.TrayHintShown {
			a.cfg.TrayHintShown = true
			a.cfg.Save()
			msg := "Die Suche läuft im Hintergrund weiter und hält den Index aktuell."
			if a.hotkeyErr == "" && a.cfg.Hotkey != "Keine" {
				msg += "\nÖffnen mit " + a.cfg.Hotkey + " oder über dieses Symbol."
			}
			ni.ShowInfo(brandName+" "+brandProduct, msg)
		}
	})
}

func (a *App) quit() {
	a.quitting = true
	a.mw.Close()
}

func (a *App) showWindow() {
	dbg("showWindow")
	if a.mw == nil {
		return
	}
	a.mw.Show()
	hwnd := a.mw.Handle()
	if win.IsIconic(hwnd) {
		win.ShowWindow(hwnd, win.SW_RESTORE)
	} else {
		win.ShowWindow(hwnd, win.SW_SHOW)
	}
	win.SetForegroundWindow(hwnd)
	a.panes[0].search.SetFocus()
	a.panes[0].search.SetTextSelection(0, -1)
}

func (a *App) applyHotkey() {
	if a.stopHotkey != nil {
		a.stopHotkey()
		a.stopHotkey = nil
	}
	a.hotkeyErr = ""
	stop, err := StartHotkey(a.cfg.Hotkey, func() { a.mw.Synchronize(a.showWindow) })
	if err != nil {
		a.hotkeyErr = err.Error() + " – bitte in den Einstellungen eine andere wählen"
	}
	a.stopHotkey = stop
	a.updateBannerHint()
}

// ---------- Start & Hintergrund-Aktualisierung ----------

func (a *App) startup() {
	ix, _ := LoadIndex(indexPath())
	firstRun := false
	decided := make(chan struct{})
	a.mw.Synchronize(func() {
		a.ix, a.ixShared = ix, ix != nil && a.cfg.sharedReader()
		a.updateInfo()
		a.scheduleSearch()
		firstRun = len(a.cfg.Folders) == 0 && a.cfg.SharedIndexDir == ""
		close(decided)
		if firstRun {
			a.showWindow()
			walk.MsgBox(a.mw, brandName+" "+brandProduct+" – Willkommen",
				"Bitte legen Sie zuerst fest, welche Ordner bzw. Netzlaufwerke durchsucht werden sollen\n"+
					"(z. B. Z:\\ oder \\\\DiskStation\\Daten).", walk.MsgBoxIconInformation)
			a.showSettings()
		}
	})

	<-decided
	if !firstRun {
		// Netzlaufwerke der Suchordner (z. B. Y:\) merken, damit sie künftig automatisch verbunden werden
		a.mw.Synchronize(func() {
			if a.cfg.learnDrives() {
				a.cfg.Save()
			}
		})
		a.connectDrives(false)
		a.mw.Synchronize(func() {
			a.openStartFolders()
			a.maintain(a.cfg.sharedIndexPath())
		})
		go a.autoRefreshFolders()
	}

	if d := detectGoogleDrive(); d != "" {
		a.mw.Synchronize(func() { a.gdrive = d; a.rebuildCopyMenus() })
	}

	for range time.Tick(5 * time.Minute) {
		a.mw.Synchronize(func() { a.maintain(a.cfg.sharedIndexPath()) })
	}
}

// maintain: läuft beim Start und alle 5 Minuten. Holt einen neueren gemeinsamen Index
// bzw. liest neu ein, wenn der Index zu alt ist.
func (a *App) maintain(sharedPath string) {
	if a.indexing {
		return
	}
	if a.cfg.sharedReader() {
		go a.pullShared(sharedPath, false)
		return
	}
	stale := a.ix == nil || a.ixShared || !sameRoots(a.ix.Roots, a.cfg.Folders) ||
		(a.cfg.RefreshHours > 0 && time.Since(a.ix.Built) > time.Duration(a.cfg.RefreshHours)*time.Hour)
	if stale && len(a.cfg.Folders) > 0 {
		a.startIndex()
	}
}

func fileMod(p string) time.Time {
	fi, err := os.Stat(p)
	if err != nil {
		return time.Time{}
	}
	return fi.ModTime()
}

// pullShared lädt den gemeinsamen Index vom NAS, wenn er neuer ist als die lokale Kopie.
func (a *App) pullShared(sharedPath string, force bool) {
	sm := fileMod(sharedPath)
	if sm.IsZero() {
		if force {
			a.mw.Synchronize(func() {
				a.setStatus("Gemeinsamer Index nicht gefunden: " + sharedPath + " – lese selbst ein …")
				a.startIndex()
			})
		}
		return
	}
	if !force && !sm.After(fileMod(indexPath())) && a.ix != nil {
		return
	}
	a.mw.Synchronize(func() { a.setStatus("Lade gemeinsamen Index vom NAS …") })
	ix, err := LoadIndex(sharedPath)
	if err != nil {
		a.mw.Synchronize(func() { a.setStatus("Gemeinsamer Index konnte nicht geladen werden: " + err.Error()) })
		return
	}
	copyFile(sharedPath, indexPath())
	a.mw.Synchronize(func() {
		a.ix, a.ixShared = ix, true
		a.updateInfo()
		a.scheduleSearch()
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	os.MkdirAll(filepath.Dir(dst), 0o755)
	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err = out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	// Ziel kann kurz von einem anderen PC gelesen werden → mehrere Versuche.
	for i := 0; i < 10; i++ {
		if err = os.Rename(tmp, dst); err == nil {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	os.Remove(tmp)
	return err
}

// connectDrives verbindet die gespeicherten Netzlaufwerke (und die Freigaben der
// Suchordner). Windows fragt bei Bedarf selbst nach Benutzername/Kennwort.
func (a *App) connectDrives(report bool) {
	var hwnd uintptr
	var drives []DriveMap
	var extra []string
	done := make(chan struct{})
	a.mw.Synchronize(func() {
		hwnd = uintptr(a.mw.Handle())
		drives = append(drives, a.cfg.Drives...)
		for _, f := range append(append([]string(nil), a.cfg.Folders...), a.cfg.SharedIndexDir) {
			if r := ShareRoot(f); r != "" {
				extra = append(extra, r)
			}
		}
		close(done)
	})
	<-done

	var problems []string
	for _, d := range drives {
		if err := ConnectShare(hwnd, d.Letter, d.Remote); err != nil {
			problems = append(problems, err.Error())
		}
	}
	for _, r := range extra {
		ConnectShare(hwnd, "", r)
	}
	if len(problems) > 0 || report {
		msg := "Netzlaufwerke verbunden."
		if len(problems) > 0 {
			msg = "Netzlaufwerk-Problem: " + strings.Join(problems, "; ")
		}
		a.mw.Synchronize(func() { a.setStatus(msg) })
	}
}

func detectGoogleDrive() string {
	for _, p := range []string{`G:\Meine Ablage`, `G:\My Drive`} {
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			return p
		}
	}
	return ""
}

func sameRoots(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !strings.EqualFold(strings.TrimSpace(a[i]), strings.TrimSpace(b[i])) {
			return false
		}
	}
	return true
}

func (a *App) updateInfo() {
	if a.ix == nil {
		a.lastInfo = "Noch kein Index vorhanden."
		if a.cfg.sharedReader() {
			a.lastInfo = "Noch kein gemeinsamer Index auf dem NAS – F5 liest selbst ein."
		}
	} else {
		src := "Index"
		if a.ixShared {
			src = "Gemeinsamer Index (NAS)"
		}
		a.lastInfo = fmt.Sprintf("%s: %s Einträge, Stand %s", src, thousands(int64(len(a.ix.Entries))),
			a.ix.Built.Format("02.01.2006 15:04"))
		if a.ix.Errors > 0 {
			a.lastInfo += fmt.Sprintf(" (%d Ordner nicht lesbar)", a.ix.Errors)
		}
	}
	if !a.indexing {
		a.setStatus(a.lastInfo)
	}
}

// ---------- Indizierung ----------

func (a *App) toggleIndex() {
	if a.indexing {
		a.stopIndex.Store(true)
		a.setStatus("Breche ab …")
		return
	}
	if a.cfg.sharedReader() {
		go a.pullShared(a.cfg.sharedIndexPath(), true)
		return
	}
	if len(a.cfg.Folders) == 0 {
		a.showWindow()
		a.showSettings()
		return
	}
	a.startIndex()
}

func (a *App) startIndex() {
	if a.indexing {
		return
	}
	folders := append([]string(nil), a.cfg.Folders...)
	if len(folders) == 0 {
		a.setStatus("Keine Ordner eingestellt – bitte unter „Einstellungen“ festlegen.")
		return
	}
	a.indexing = true
	a.stopIndex.Store(false)
	a.refreshBt.SetText("Abbrechen")
	excludes := append([]string(nil), a.cfg.Excludes...)
	workers := a.cfg.Workers
	sharedPath := ""
	if a.cfg.SharedWriter {
		sharedPath = a.cfg.sharedIndexPath()
	}

	p := &Progress{}
	p.Current.Store("")
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(300 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				cur, _ := p.Current.Load().(string)
				msg := fmt.Sprintf("Lese Ordner ein … %s Einträge in %s Ordnern – %s",
					thousands(p.Files.Load()), thousands(p.Folders.Load()), cur)
				a.mw.Synchronize(func() { a.setStatus(msg) })
			}
		}
	}()

	go func() {
		start := time.Now()
		ix := BuildIndex(folders, excludes, workers, &a.stopIndex, p)
		close(done)
		cancelled := a.stopIndex.Load()
		var shareErr error
		if !cancelled {
			SaveIndex(ix, indexPath())
			if sharedPath != "" {
				shareErr = copyFile(indexPath(), sharedPath)
			}
		}
		a.mw.Synchronize(func() {
			a.indexing = false
			a.refreshBt.SetText("Aktualisieren (F5)")
			if cancelled {
				a.updateInfo()
				a.setStatus("Einlesen abgebrochen. " + a.lastInfo)
				return
			}
			a.ix, a.ixShared = ix, false
			a.updateInfo()
			msg := fmt.Sprintf("%s (eingelesen in %s)", a.lastInfo, time.Since(start).Round(time.Second))
			if sharedPath != "" {
				if shareErr != nil {
					msg += " – gemeinsamer Index konnte NICHT gespeichert werden: " + shareErr.Error()
				} else {
					msg += " – auf dem NAS für alle bereitgestellt"
				}
			}
			a.setStatus(msg)
			a.scheduleSearch()
		})
	}()
}

// ---------- Zwei Ansichten ----------

func (a *App) scheduleSearch() {
	for _, p := range a.panes {
		p.scheduleSearch()
	}
}

func (a *App) rebuildCopyMenus() {
	for _, p := range a.panes {
		p.rebuildCopyMenu()
	}
}

// activePane: die Hälfte, in der zuletzt gearbeitet wurde (Fokus), sonst links.
func (a *App) activePane() *Pane {
	f := win.GetFocus()
	for _, p := range a.panes {
		if p.root.Visible() && (f == p.root.Handle() || win.IsChild(p.root.Handle(), f)) {
			return p
		}
	}
	if a.lastPane != nil && a.lastPane.root.Visible() {
		return a.lastPane
	}
	return a.panes[0]
}

// setNavVisible blendet die Navigationsleiste (Schnellzugriff, Netzlaufwerke, Dieser PC) ein/aus.
func (a *App) setNavVisible(on bool) {
	changed := on == a.cfg.HideNav
	a.cfg.HideNav = !on
	a.nav.tv.SetVisible(on)
	if on {
		a.navBt.SetText("Navigation ausblenden")
	} else {
		a.navBt.SetText("Navigation einblenden")
	}
	if changed {
		a.cfg.Save()
	}
}

// setSecondPane blendet die rechte Hälfte ein oder aus (wird gespeichert).
func (a *App) setSecondPane(on bool) {
	changed := on != a.cfg.SecondPane
	a.cfg.SecondPane = on
	a.panes[1].root.SetVisible(on)
	if on {
		a.secondBt.SetText("Zweite Ansicht ausblenden")
		// bei schmalem Fenster etwas verbreitern
		if b := a.mw.Bounds(); b.Width < 1500 {
			b.Width = 1500
			a.mw.SetBounds(b)
		}
		a.panes[1].scheduleSearch()
	} else {
		a.secondBt.SetText("Zweite Ansicht einblenden")
	}
	if changed {
		a.cfg.Save()
	}
}

// transfer verschiebt oder kopiert Dateien in einen Ordner (Windows-Fortschrittsdialog),
// aktualisiert danach den Index im Speicher und beide Ansichten.
func (a *App) transfer(paths []string, target string, move bool) {
	var todo []string
	for _, s := range paths {
		if strings.EqualFold(filepath.Dir(s), target) || strings.EqualFold(s, target) {
			continue
		}
		todo = append(todo, s)
	}
	if len(todo) == 0 {
		return
	}
	verb := map[bool]string{true: "Verschiebe", false: "Kopiere"}[move]
	a.setStatus(fmt.Sprintf("%s %d Element(e) nach %s …", verb, len(todo), target))
	go func() {
		var err error
		if move {
			err = MoveFilesTo(todo, target)
		} else {
			err = CopyFilesTo(todo, target)
		}
		// Was ist tatsächlich passiert? (Abbruch, Konflikte …)
		moves := map[string]string{}
		done := 0
		for _, s := range todo {
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
		a.mw.Synchronize(func() {
			if len(moves) > 0 && a.ix != nil {
				a.ix = a.ix.WithMoves(moves)
			}
			for _, p := range a.panes {
				p.scheduleSearch()
			}
			msg := fmt.Sprintf("%d Element(e) nach %s %s.", done, target,
				map[bool]string{true: "verschoben", false: "kopiert"}[move])
			if err != nil && done == 0 {
				msg = err.Error()
			}
			a.setStatus(msg)
			a.stickyUntil = time.Now().Add(4 * time.Second)
		})
	}()
}

func windowTitle() string {
	t := brandName + " " + brandProduct
	if portableMode() {
		t += " (portabel)"
	}
	return t
}
