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
	mw           *walk.MainWindow
	header       *walk.CustomWidget
	banner       *banner
	searchPane   *Pane    // oben: Suche
	panes        [2]*Pane // unten: Explorer links und rechts
	nav          *Navigator
	lastPane     *Pane // zuletzt benutzte Ansicht (Ziel der Befehlsleiste)
	lastExplorer *Pane // zuletzt benutzte Explorer-Ansicht (Ziel für Klicks im Navigationsbaum)
	navBt        *walk.PushButton
	refreshBt    *walk.PushButton
	pasteBt      *walk.PushButton
	status       *walk.StatusBarItem
	icon         *walk.Icon
	tray         *walk.NotifyIcon

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

	stickyUntil time.Time       // bis dahin überschreiben die Ansichten die Statuszeile nicht
	dragSource  bool            // gerade werden Dateien aus dem Programm gezogen
	cutPaths    map[string]bool // ausgeschnitten (Strg+X) – werden blass angezeigt
	saveTimer   *time.Timer
}

func main() {
	if isNativeHostCall(os.Args[1:]) {
		runNativeHost() // von Chrome gestartet
		return
	}
	app := &App{cfg: LoadConfig(), cutPaths: map[string]bool{}}
	app.panes = [2]*Pane{newPane(app, 0), newPane(app, 1)}
	app.searchPane = newPane(app, 2)
	app.lastExplorer = app.panes[0]
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

	cmd := func(text, tip string, f func()) PushButton {
		return PushButton{Text: text, ToolTipText: tip, OnClicked: f}
	}
	err := MainWindow{
		AssignTo: &a.mw,
		Title:    windowTitle(),
		Icon:     a.icon,
		Visible:  !a.startTray,
		MinSize:  Size{Width: 900, Height: 560},
		Size:     Size{Width: 1500, Height: 900},
		Layout:   VBox{MarginsZero: true, SpacingZero: true},
		Children: []Widget{
			CustomWidget{
				AssignTo:            &a.header,
				StretchFactor:       1,
				Alignment:           AlignHNearVNear,
				MinSize:             Size{Height: 50},
				MaxSize:             Size{Height: 50},
				InvalidatesOnResize: true,
				PaintMode:           PaintNoErase,
				Paint:               a.banner.paint(&a.header),
			},
			// Befehlsleiste wie im Explorer – wirkt auf die zuletzt angeklickte Ansicht
			Composite{
				Layout:  HBox{Margins: Margins{Left: 9, Top: 5, Right: 9, Bottom: 0}, Spacing: 3},
				MaxSize: Size{Height: 34},
				Children: []Widget{
					cmd("Neu ▾", "Neuer Ordner (Strg+Umschalt+N) oder neues Textdokument", a.cmdNew),
					cmd("Ausschneiden", "Strg+X – danach mit Einfügen verschieben (auch in den Windows-Explorer)", func() { a.clipboardSet(a.cmdPane(), true) }),
					cmd("Kopieren", "Strg+C", func() { a.clipboardSet(a.cmdPane(), false) }),
					PushButton{AssignTo: &a.pasteBt, Text: "Einfügen", ToolTipText: "Strg+V – in den angezeigten Ordner", OnClicked: func() { a.paste(a.cmdPane()) }},
					cmd("Umbenennen", "F2 – mehrere markiert: gemeinsamer Name mit Nummer", func() { a.cmdPane().rename() }),
					cmd("Löschen", "Entf = Papierkorb, Umschalt+Entf = endgültig", func() { a.cmdPane().deleteSelected(!walk.ShiftDown()) }),
					HSpacer{Size: 10},
					cmd("Kopieren ⇄", "Markierte Elemente in den Ordner der anderen Seite kopieren", func() { a.cmdToOther(false) }),
					cmd("Verschieben ⇄", "Markierte Elemente in den Ordner der anderen Seite verschieben", func() { a.cmdToOther(true) }),
					cmd("Eigenschaften", "Alt+Enter", func() { a.cmdPane().properties() }),
					HSpacer{},
					PushButton{AssignTo: &a.navBt, Text: "Navigation ausblenden", OnClicked: func() { a.setNavVisible(a.cfg.HideNav) }},
					PushButton{AssignTo: &a.refreshBt, Text: "Index aktualisieren", ToolTipText: "Suchordner neu einlesen", OnClicked: a.toggleIndex},
					cmd("Einstellungen …", "Suchordner, Netzlaufwerke, Tastenkombination, Browser", a.showSettings),
				},
			},
			VSplitter{
				StretchFactor: 1000,
				HandleWidth:   6,
				Children: []Widget{
					Composite{
						StretchFactor: 1, // oben höchstens ein Drittel: Suche
						Layout:        VBox{MarginsZero: true},
						Children:      []Widget{a.searchPane.searchWidget()},
					},
					Composite{
						StretchFactor: 2, // unten zwei Drittel: zwei Explorer-Ansichten nebeneinander
						Layout:        HBox{Margins: Margins{Left: 9, Top: 2, Right: 9, Bottom: 3}, Spacing: 8},
						Children: []Widget{
							TreeView{AssignTo: &a.nav.tv, MinSize: Size{Width: 180}, MaxSize: Size{Width: 250}},
							a.panes[0].explorerWidget(), a.panes[1].explorerWidget(),
						},
					},
				},
			},
		},
		StatusBarItems: []StatusBarItem{{AssignTo: &a.status, Width: 1400}},
	}.Create()
	if err != nil {
		walk.MsgBox(nil, brandProduct, "Fehler beim Start: "+err.Error(), walk.MsgBoxIconError)
		return
	}

	shortcut := func(key walk.Key, mods walk.Modifiers, f func()) {
		act := walk.NewAction()
		act.SetShortcut(walk.Shortcut{Modifiers: mods, Key: key})
		act.Triggered().Attach(f)
		a.mw.ShortcutActions().Add(act)
	}
	focusSearch := func() {
		a.searchPane.searchEd.SetFocus()
		a.searchPane.searchEd.SetTextSelection(0, -1)
	}
	shortcut(walk.KeyF, walk.ModControl, focusSearch)
	shortcut(walk.KeyE, walk.ModControl, focusSearch)
	shortcut(walk.KeyF3, 0, focusSearch)
	shortcut(walk.KeyTab, walk.ModControl, a.switchPane)
	installAltKeyHook(a.altKey)

	a.searchPane.init()
	for _, p := range a.panes {
		p.init()
	}
	a.nav.init()
	a.setNavVisible(!a.cfg.HideNav)
	a.setupTray()
	a.applyHotkey()

	a.setStatus("Lade Index …")
	a.startWeb()
	go a.startup()
	a.mw.Run()
	a.stopIndex.Store(true)
	a.cfg.Save()
	if a.stopHotkey != nil {
		a.stopHotkey()
	}
	if a.tray != nil {
		a.tray.Dispose()
	}
}

func (a *App) setStatus(s string) { a.status.SetText(" " + s) }

// sticky: Meldung bleibt ein paar Sekunden stehen.
func (a *App) sticky(s string) {
	a.setStatus(s)
	a.stickyUntil = time.Now().Add(4 * time.Second)
}

func (a *App) saveSoon() {
	if a.saveTimer != nil {
		a.saveTimer.Stop()
	}
	a.saveTimer = time.AfterFunc(2*time.Second, func() { a.mw.Synchronize(func() { a.cfg.Save() }) })
}

func (a *App) updateBannerHint() {
	switch {
	case a.hotkeyErr != "":
		a.banner.hintText = a.hotkeyErr
	case a.cfg.Hotkey != "" && a.cfg.Hotkey != "Keine":
		a.banner.hintText = a.cfg.Hotkey + " öffnet den Explorer jederzeit"
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
	add("Explorer öffnen", a.showWindow)
	add("Index aktualisieren", a.toggleIndex)
	add("Einstellungen …", func() { a.showWindow(); a.showSettings() })
	add("Im Browser einrichten …", func() { a.setupChrome(a.mw) })
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
			msg := "Der Explorer läuft im Hintergrund weiter und hält den Suchindex aktuell."
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
	a.searchPane.searchEd.SetFocus()
	a.searchPane.searchEd.SetTextSelection(0, -1)
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
	ix, err := LoadIndex(indexPath())
	if err != nil && !portableMode() {
		// noch kein eigener Index: den der NAS-Suche übernehmen (gleiche Suchordner)
		if nix, e := LoadIndex(nasSucheIndexPath()); e == nil && sameRoots(nix.Roots, a.cfg.Folders) {
			ix = nix
			copyFile(nasSucheIndexPath(), indexPath())
		}
	}
	a.mw.Synchronize(func() {
		a.ix, a.ixShared = ix, ix != nil && a.cfg.sharedReader()
		a.updateInfo()
		a.searchPane.scheduleSearch()
		if a.cfg.learnDrives() {
			a.cfg.Save()
		}
	})
	a.connectDrives(false)
	a.mw.Synchronize(func() {
		a.openStartFolders()
		if len(a.cfg.Folders) == 0 && a.cfg.SharedIndexDir == "" && !a.cfg.TrayHintShown {
			a.showWindow()
			if walk.MsgBox(a.mw, brandName+" "+brandProduct+" – Willkommen",
				"Für die schnelle Suche oben legen Sie einmal fest, welche Ordner bzw. Netzlaufwerke\n"+
					"eingelesen werden sollen (z. B. Z:\\ oder \\\\DiskStation\\Daten).\n\nJetzt einrichten?",
				walk.MsgBoxYesNo|walk.MsgBoxIconInformation) == walk.DlgCmdYes {
				a.showSettings()
			}
		}
		a.maintain(a.cfg.sharedIndexPath())
	})
	go a.autoRefreshFolders()

	if d := detectGoogleDrive(); d != "" {
		a.mw.Synchronize(func() { a.gdrive = d })
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
		a.searchPane.scheduleSearch()
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

func (a *App) updateInfo() {
	if a.ix == nil {
		a.lastInfo = "Noch kein Suchindex – unter „Einstellungen“ Suchordner festlegen."
		if a.cfg.sharedReader() {
			a.lastInfo = "Noch kein gemeinsamer Index auf dem NAS – „Index aktualisieren“ liest selbst ein."
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
		a.setStatus("Keine Suchordner eingestellt – bitte unter „Einstellungen“ festlegen.")
		return
	}
	a.indexing = true
	a.stopIndex.Store(false)
	a.refreshBt.SetText("Einlesen abbrechen")
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
				msg := fmt.Sprintf("Lese Suchordner ein … %s Einträge in %s Ordnern – %s",
					thousands(p.Files.Load()), thousands(p.Folders.Load()), cur)
				a.mw.Synchronize(func() {
					if time.Now().After(a.stickyUntil) && !a.dragSource {
						a.setStatus(msg)
					}
				})
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
			a.refreshBt.SetText("Index aktualisieren")
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
			a.searchPane.scheduleSearch()
		})
	}()
}

// ---------- Ansichten ----------

func (a *App) allPanes() []*Pane { return []*Pane{a.searchPane, a.panes[0], a.panes[1]} }

// activePane: die Ansicht mit dem Fokus, sonst die zuletzt benutzte.
func (a *App) activePane() *Pane {
	f := win.GetFocus()
	for _, p := range a.allPanes() {
		if f == p.root.Handle() || win.IsChild(p.root.Handle(), f) {
			return p
		}
	}
	if a.lastPane != nil {
		return a.lastPane
	}
	return a.panes[0]
}

// cmdPane: Ziel der Befehlsleiste (die Knöpfe nehmen selbst den Fokus).
func (a *App) cmdPane() *Pane {
	if a.lastPane != nil {
		return a.lastPane
	}
	return a.panes[0]
}

// explorerPane: die zuletzt benutzte untere Ansicht.
func (a *App) explorerPane() *Pane {
	if a.lastExplorer != nil {
		return a.lastExplorer
	}
	return a.panes[0]
}

// switchPane: Strg+Tab wechselt Suche → links → rechts.
func (a *App) switchPane() {
	all := a.allPanes()
	cur := a.activePane()
	for i, p := range all {
		if p == cur {
			n := all[(i+1)%len(all)]
			if n.search {
				n.searchEd.SetFocus()
			} else {
				n.tv.SetFocus()
			}
			return
		}
	}
}

// altKey: Alt+← zurück, Alt+→ vor, Alt+↑ nach oben, Alt+Enter Eigenschaften, Alt+D Adresse.
func (a *App) altKey(vk uint32) bool {
	if a.mw == nil || win.GetForegroundWindow() != a.mw.Handle() {
		return false
	}
	p := a.activePane()
	run := func(f func()) bool { a.mw.Synchronize(f); return true }
	switch vk {
	case win.VK_LEFT:
		if !p.search {
			return run(p.goBack)
		}
	case win.VK_RIGHT:
		if !p.search {
			return run(p.goForward)
		}
	case win.VK_UP:
		if !p.search {
			return run(p.goUp)
		}
	case win.VK_RETURN:
		return run(p.properties)
	case 'D':
		if !p.search {
			return run(p.editAddress)
		}
	}
	return false
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

func (a *App) updateCommands() {
	if a.pasteBt != nil {
		a.pasteBt.SetEnabled(ClipboardHasFiles())
	}
}

func (a *App) toggleHidden() {
	a.cfg.ShowHidden = !a.cfg.ShowHidden
	a.cfg.Save()
	for _, p := range a.panes {
		p.refreshFolder()
	}
}

// refreshExplorers liest beide unteren Ansichten neu (Auswahl bleibt).
func (a *App) refreshExplorers() {
	for _, p := range a.panes {
		p.loadFolder(false, "")
	}
}

// ---------- Befehle ----------

func (a *App) cmdNew() {
	p := a.cmdPane()
	if p.search {
		p = a.explorerPane()
	}
	var pt win.POINT
	win.GetCursorPos(&pt)
	popupMenu(a.mw.Handle(), pt.X, pt.Y, []popItem{
		{text: "Ordner\tStrg+Umschalt+N", action: p.newFolder},
		{text: "Textdokument", action: func() { p.newItem(false) }},
	})
}

// cmdToOther: Markierte Elemente in den Ordner der anderen Seite kopieren/verschieben.
func (a *App) cmdToOther(move bool) {
	p := a.cmdPane()
	paths := p.selectedPaths()
	if len(paths) == 0 {
		a.sticky("Bitte erst Dateien oder Ordner markieren.")
		return
	}
	if !p.search {
		a.transfer(paths, p.other().model.folder, move)
		return
	}
	var pt win.POINT
	win.GetCursorPos(&pt)
	verb := map[bool]string{true: "Verschieben", false: "Kopieren"}[move]
	popupMenu(a.mw.Handle(), pt.X, pt.Y, []popItem{
		{text: verb + " nach links:  " + a.panes[0].model.folder, action: func() { a.transfer(paths, a.panes[0].model.folder, move) }},
		{text: verb + " nach rechts:  " + a.panes[1].model.folder, action: func() { a.transfer(paths, a.panes[1].model.folder, move) }},
	})
}

// targetMenu: Ziele für „Verschieben nach“ / „Kopieren nach“.
func (a *App) targetMenu(p *Pane, paths []string, move bool) []popItem {
	var items []popItem
	for _, q := range a.panes {
		if q == p || q.model.folder == "" {
			continue
		}
		q := q
		items = append(items, popItem{text: "Ordner " + q.side() + ":  " + q.model.folder,
			action: func() { a.transfer(paths, q.model.folder, move) }})
	}
	targets := append([]string(nil), a.cfg.CopyTargets...)
	if a.gdrive != "" {
		known := false
		for _, t := range targets {
			known = known || strings.EqualFold(t, a.gdrive)
		}
		if !known {
			targets = append(targets, a.gdrive)
		}
	}
	if len(targets) > 0 {
		items = append(items, popItem{separator: true})
	}
	for _, t := range targets {
		t := t
		label := t
		if strings.EqualFold(t, a.gdrive) {
			label = "Google Drive  (" + t + ")"
		}
		items = append(items, popItem{text: label, action: func() { a.transferRemember(paths, t, move) }})
	}
	items = append(items, popItem{separator: true}, popItem{text: "Ordner auswählen …", action: func() {
		fd := &walk.FileDialog{Title: map[bool]string{true: "Wohin verschieben?", false: "Wohin kopieren?"}[move]}
		if ok, _ := fd.ShowBrowseFolder(a.mw); ok && fd.FilePath != "" {
			a.transferRemember(paths, fd.FilePath, move)
		}
	}})
	return items
}

func (a *App) transferRemember(paths []string, target string, move bool) {
	a.cfg.addCopyTarget(target)
	a.cfg.Save()
	a.transfer(paths, target, move)
}

// clipboardSet: Strg+C / Strg+X – Dateien in die Windows-Zwischenablage (auch für den Explorer).
func (a *App) clipboardSet(p *Pane, cut bool) {
	paths := p.selectedPaths()
	if len(paths) == 0 {
		return
	}
	if err := SetClipboardFiles(uintptr(a.mw.Handle()), paths, cut); err != nil {
		a.sticky("Zwischenablage: " + err.Error())
		return
	}
	a.cutPaths = map[string]bool{}
	if cut {
		for _, s := range paths {
			a.cutPaths[strings.ToLower(s)] = true
		}
		a.sticky(fmt.Sprintf("%d Element(e) ausgeschnitten – im Zielordner Strg+V (oder Einfügen) verschiebt sie.", len(paths)))
	} else {
		a.sticky(fmt.Sprintf("%d Element(e) kopiert – mit Strg+V einfügen (hier, im Explorer, in E-Mails, Google Drive …).", len(paths)))
	}
	for _, q := range a.allPanes() {
		q.tv.Invalidate()
	}
	a.updateCommands()
}

// paste: Strg+V in einer Ansicht – in den angezeigten Ordner (bzw. den markierten Ordner der Suche).
func (a *App) paste(p *Pane) {
	target := p.targetFolder()
	if p.search {
		ents := p.selectedEntries()
		if len(ents) == 1 && ents[0].IsDir {
			target = p.selectedPaths()[0]
		} else {
			target = a.explorerPane().model.folder
		}
	}
	a.pasteInto(target)
}

func (a *App) pasteInto(target string) {
	if target == "" {
		return
	}
	a.setStatus("Füge ein …")
	go func() {
		msg, err := a.Paste(target)
		a.mw.Synchronize(func() {
			if err != nil {
				msg = err.Error()
			}
			a.sticky(msg)
		})
	}()
}

// Paste (blockiert, nicht im Oberflächen-Thread aufrufen): Dateien aus der Zwischenablage nach
// target – ausgeschnittene werden verschoben, kopierte im selben Ordner als „… - Kopie“ angelegt.
func (a *App) Paste(target string) (string, error) {
	var hwnd uintptr
	a.Sync(func() { hwnd = uintptr(a.mw.Handle()) })
	paths, move, err := GetClipboardFiles(hwnd)
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "In der Zwischenablage liegen keine Dateien.", nil
	}
	var todo []string
	same := false
	for _, s := range paths {
		if strings.EqualFold(s, target) || strings.HasPrefix(strings.ToLower(target), strings.ToLower(s)+`\`) {
			continue // nicht in sich selbst
		}
		if strings.EqualFold(filepath.Dir(s), target) {
			if move {
				continue
			}
			same = true
		}
		todo = append(todo, s)
	}
	if len(todo) == 0 {
		return "Liegt schon dort – nichts zu tun.", nil
	}
	defer a.Sync(func() { a.refreshExplorers(); notifyChanged(target) })
	if move {
		moves, done, err := a.Transfer(todo, target, true)
		ClearClipboard(hwnd)
		a.Sync(func() {
			a.cutPaths = map[string]bool{}
			a.updateCommands()
		})
		if err != nil && done == 0 {
			return "", err
		}
		return fmt.Sprintf("%d Element(e) nach %s verschoben.", len(moves), target), nil
	}
	if same {
		if err := CopyFilesRename(hwnd, todo, target); err != nil {
			return "", err
		}
		return fmt.Sprintf("%d Element(e) in %s eingefügt.", len(todo), target), nil
	}
	_, done, err := a.Transfer(todo, target, false)
	if err != nil && done == 0 {
		return "", err
	}
	return fmt.Sprintf("%d Element(e) nach %s kopiert.", done, target), nil
}

// transfer verschiebt oder kopiert Dateien in einen Ordner (Windows-Fortschrittsdialog),
// aktualisiert danach den Index im Speicher und alle Ansichten.
func (a *App) transfer(paths []string, target string, move bool) {
	if target == "" {
		return
	}
	var todo []string
	for _, s := range paths {
		if strings.EqualFold(filepath.Dir(s), target) || strings.EqualFold(s, target) ||
			strings.HasPrefix(strings.ToLower(target), strings.ToLower(s)+`\`) {
			continue
		}
		todo = append(todo, s)
	}
	if len(todo) == 0 {
		a.sticky("Liegt schon dort – nichts zu tun.")
		return
	}
	verb := map[bool]string{true: "Verschiebe", false: "Kopiere"}[move]
	a.setStatus(fmt.Sprintf("%s %d Element(e) nach %s …", verb, len(todo), target))
	go func() {
		moves, done, err := a.Transfer(todo, target, move)
		a.mw.Synchronize(func() {
			for s := range moves {
				delete(a.cutPaths, strings.ToLower(s))
			}
			msg := fmt.Sprintf("%d Element(e) nach %s %s.", done, target,
				map[bool]string{true: "verschoben", false: "kopiert"}[move])
			if err != nil && done == 0 {
				msg = err.Error()
			}
			a.sticky(msg)
			a.refreshExplorers()
			notifyChanged(target)
		})
	}()
}

// deletePaths löscht mit dem Windows-Dialog und nimmt Gelöschtes aus dem Index.
func (a *App) deletePaths(paths []string, recycle bool) {
	hwnd := uintptr(a.mw.Handle())
	go func() {
		err := DeleteFiles(hwnd, paths, recycle)
		var gone []string
		for _, s := range paths {
			if _, e := os.Lstat(s); os.IsNotExist(e) {
				gone = append(gone, s)
			}
		}
		a.mw.Synchronize(func() {
			a.removed(gone)
			switch {
			case err != nil && len(gone) == 0:
				a.sticky(err.Error())
			case len(gone) > 0 && recycle:
				a.sticky(fmt.Sprintf("%d Element(e) gelöscht (Papierkorb).", len(gone)))
			case len(gone) > 0:
				a.sticky(fmt.Sprintf("%d Element(e) endgültig gelöscht.", len(gone)))
			}
			a.refreshExplorers()
		})
	}()
}

// afterShellChange: nach dem Windows-Menü oder dem Ziehen in den Explorer nachsehen, was weg ist.
func (a *App) afterShellChange(paths []string) {
	var gone []string
	for _, s := range paths {
		if _, e := os.Lstat(s); os.IsNotExist(e) {
			gone = append(gone, s)
		}
	}
	a.removed(gone)
	a.refreshExplorers()
	time.AfterFunc(1500*time.Millisecond, func() { a.mw.Synchronize(a.refreshExplorers) })
}

// removed: gelöschte bzw. von außen verschobene Elemente aus dem Index nehmen.
func (a *App) removed(paths []string) {
	if len(paths) == 0 || a.ix == nil {
		return
	}
	a.ix = a.ix.WithRemoved(paths)
	if !a.ixShared {
		saveIndexSoon(func() *Index { return a.ix })
	}
	a.searchPane.scheduleSearch()
}

// added: neue Elemente (Neuer Ordner, Kopien) sofort suchbar machen.
func (a *App) added(paths []string) {
	if len(paths) == 0 || a.ix == nil {
		return
	}
	a.ix = a.ix.WithAdded(paths)
	if !a.ixShared {
		saveIndexSoon(func() *Index { return a.ix })
	}
}

func windowTitle() string {
	t := brandName + " " + brandProduct + "  –  " + versionText()
	if portableMode() {
		t += " (portabel)"
	}
	return t
}
