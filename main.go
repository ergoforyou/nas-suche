//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/lxn/walk"
	. "github.com/lxn/walk/declarative"
	"github.com/lxn/win"
)

const maxResults = 100000

type App struct {
	mw         *walk.MainWindow
	header     *walk.CustomWidget
	banner     *banner
	search     *walk.LineEdit
	filterBtns [CatFolder + 1]*walk.RadioButton
	inPath     *walk.CheckBox
	refreshBt  *walk.PushButton
	tv         *walk.TableView
	copyMenu   *walk.Menu
	status     *walk.StatusBarItem
	model      *ResultModel
	icon       *walk.Icon
	tray       *walk.NotifyIcon

	cfg       *Config
	ix        *Index
	ixShared  bool // aktueller Index stammt vom NAS
	searchGen atomic.Int64
	debounce  *time.Timer

	indexing   bool
	stopIndex  atomic.Bool
	lastInfo   string
	quitting   bool
	startTray  bool
	stopHotkey func()
	hotkeyErr  string
	gdrive     string // erkannter Google-Drive-Ordner

	dragArmed bool
	dragX     int
	dragY     int
}

func main() {
	app := &App{cfg: LoadConfig(), model: &ResultModel{sortCol: 0, asc: true}}
	for _, arg := range os.Args[1:] {
		if strings.EqualFold(arg, "/tray") || strings.EqualFold(arg, "-tray") {
			app.startTray = true
		}
	}
	first, notify := SingleInstance(func() {
		dbg("zweiter Start erkannt, mw=%v", app.mw != nil)
		if app.mw != nil {
			app.mw.Synchronize(app.showWindow)
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
		Title:    brandName + " " + brandProduct,
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
				Layout:        VBox{Margins: Margins{Left: 9, Top: 9, Right: 9, Bottom: 4}},
				Children: []Widget{
					Composite{
						Layout:  HBox{MarginsZero: true},
						MaxSize: Size{Height: 34},
						Children: []Widget{
							LineEdit{
								AssignTo:      &a.search,
								CueBanner:     "Suchen …  z. B.  angebot müller *.pdf",
								Font:          Font{Family: "Segoe UI", PointSize: 12},
								OnTextChanged: a.scheduleSearch,
								OnKeyDown:     a.searchKey,
							},
							CheckBox{
								AssignTo:         &a.inPath,
								Text:             "Auch im Ordnerpfad suchen",
								Checked:          a.cfg.InPath,
								OnCheckedChanged: func() { a.cfg.InPath = a.inPath.Checked(); a.cfg.Save(); a.scheduleSearch() },
							},
							PushButton{AssignTo: &a.refreshBt, Text: "Aktualisieren (F5)", OnClicked: a.toggleIndex},
							PushButton{Text: "Einstellungen …", OnClicked: a.showSettings},
						},
					},
					Composite{
						Layout:  HBox{MarginsZero: true, Spacing: 4},
						MaxSize: Size{Height: 30},
						Children: []Widget{
							Label{Text: "Schnellfilter:", TextColor: grey},
							Composite{
								Layout:   HBox{MarginsZero: true, Spacing: 2},
								Children: a.filterItems(),
							},
							HSpacer{},
						},
					},
					TableView{
						AssignTo:         &a.tv,
						StretchFactor:    1000,
						AlternatingRowBG: true,
						MultiSelection:   true,
						Columns: []TableViewColumn{
							{Title: "Name", Width: 340},
							{Title: "Ordner", Width: 500},
							{Title: "Größe", Width: 90, Alignment: AlignFar},
							{Title: "Geändert", Width: 120},
						},
						Model:           a.model,
						OnItemActivated: a.openSelected,
						ContextMenuItems: []MenuItem{
							Action{Text: "Öffnen\tEnter", OnTriggered: a.openSelected},
							Action{Text: "Im Ordner anzeigen", OnTriggered: a.showInFolder},
							Separator{},
							Action{Text: "Kopieren (Dateien)\tStrg+C", OnTriggered: a.copyFiles},
							Menu{AssignTo: &a.copyMenu, Text: "Kopieren nach", Items: []MenuItem{
								Action{Text: "Ordner auswählen …"},
							}},
							Separator{},
							Action{Text: "Pfad kopieren\tStrg+Umschalt+C", OnTriggered: func() { a.copyText(true) }},
							Action{Text: "Name kopieren", OnTriggered: func() { a.copyText(false) }},
						},
					},
					Label{
						Text:      "Tipp: Treffer einfach mit der Maus herausziehen – in den Explorer, Outlook, Google Drive oder Claude im Browser.  Strg+C kopiert die Dateien, Rechtsklick → „Kopieren nach“.",
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

	a.tv.KeyDown().Attach(func(key walk.Key) {
		switch {
		case key == walk.KeyC && walk.ControlDown() && walk.ShiftDown():
			a.copyText(true)
		case key == walk.KeyC && walk.ControlDown():
			a.copyFiles()
		}
	})
	shortcut := func(key walk.Key, f func()) {
		act := walk.NewAction()
		act.SetShortcut(walk.Shortcut{Key: key})
		act.Triggered().Attach(f)
		a.mw.ShortcutActions().Add(act)
	}
	shortcut(walk.KeyF5, a.toggleIndex)
	for c := CatAll; c <= CatFolder; c++ {
		c := c
		act := walk.NewAction()
		act.SetShortcut(walk.Shortcut{Modifiers: walk.ModControl, Key: walk.Key1 + walk.Key(c)})
		act.Triggered().Attach(func() { a.setFilter(c) })
		a.mw.ShortcutActions().Add(act)
	}
	a.styleFilterButtons()
	a.updateFilterButtons(nil)
	shortcut(walk.KeyEscape, func() {
		// Esc: erst Suchfeld leeren, beim zweiten Mal Fenster ausblenden
		if a.search.Text() != "" {
			a.search.SetText("")
			a.search.SetFocus()
		} else if a.tray != nil {
			a.mw.Hide()
		}
	})
	a.model.onReset = func() { a.tv.Invalidate() }
	a.setupDrag()
	a.setupTray()
	a.applyHotkey()
	a.rebuildCopyMenu()

	a.setStatus("Lade Index …")
	go a.startup()
	a.search.SetFocus()
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
	a.search.SetFocus()
	a.search.SetTextSelection(0, -1)
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

func (a *App) searchKey(key walk.Key) {
	switch key {
	case walk.KeyDown, walk.KeyReturn:
		if a.model.RowCount() > 0 {
			a.tv.SetFocus()
			a.tv.SetCurrentIndex(0)
		}
	}
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
		a.connectDrives(false)
		a.mw.Synchronize(func() { a.maintain(a.cfg.sharedIndexPath()) })
	}

	if d := detectGoogleDrive(); d != "" {
		a.mw.Synchronize(func() { a.gdrive = d; a.rebuildCopyMenu() })
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

// ---------- Suche ----------

func (a *App) scheduleSearch() {
	gen := a.searchGen.Add(1)
	if a.debounce != nil {
		a.debounce.Stop()
	}
	a.debounce = time.AfterFunc(120*time.Millisecond, func() {
		a.mw.Synchronize(func() { a.runSearch(gen) })
	})
}

func (a *App) runSearch(gen int64) {
	if gen != a.searchGen.Load() {
		return
	}
	ix := a.ix
	q := Query{Text: a.search.Text(), Filter: a.cfg.Filter, InPath: a.inPath.Checked(), MaxResult: maxResults}
	if ix == nil || (strings.TrimSpace(q.Text) == "" && q.Filter == CatAll) {
		a.model.set(ix, nil)
		a.updateFilterButtons(nil)
		if !a.indexing {
			a.setStatus(a.lastInfo)
		}
		return
	}
	go func() {
		start := time.Now()
		res, total, counts := ix.Search(q, func() bool { return gen != a.searchGen.Load() })
		if gen != a.searchGen.Load() {
			return
		}
		el := time.Since(start)
		a.mw.Synchronize(func() {
			if gen != a.searchGen.Load() {
				return
			}
			a.model.set(ix, res)
			a.updateFilterButtons(&counts)
			if !a.indexing {
				msg := fmt.Sprintf("%s Treffer (%d ms)", thousands(int64(total)), el.Milliseconds())
				if q.Filter != CatAll {
					msg = CatNames[q.Filter] + ": " + msg
				}
				if total > len(res) {
					msg += fmt.Sprintf(" – nur die ersten %s werden angezeigt, bitte Suche verfeinern", thousands(int64(len(res))))
				}
				a.setStatus(msg + "   |   " + a.lastInfo)
			}
		})
	}()
}

// ---------- Schnellfilter ----------

func (a *App) filterItems() []Widget {
	var items []Widget
	for c := CatAll; c <= CatFolder; c++ {
		c := c
		items = append(items, RadioButton{
			AssignTo:  &a.filterBtns[c],
			Text:      CatNames[c],
			MinSize:   Size{Width: 92, Height: 26},
			OnClicked: func() { a.setFilter(c) },
		})
	}
	return items
}

// styleFilterButtons macht aus den Optionsfeldern Umschaltknöpfe (eingedrückt = aktiv).
func (a *App) styleFilterButtons() {
	const bsPushLike = 0x1000
	for _, b := range a.filterBtns {
		h := b.Handle()
		win.SetWindowLong(h, win.GWL_STYLE, win.GetWindowLong(h, win.GWL_STYLE)|bsPushLike)
		b.Invalidate()
	}
}

// setFilter wählt den Schnellfilter (wird gespeichert und gilt auch beim nächsten Start).
func (a *App) setFilter(c int) {
	if c < CatAll || c > CatFolder {
		c = CatAll
	}
	a.cfg.Filter = c
	a.cfg.Save()
	for i, b := range a.filterBtns {
		if b != nil {
			b.SetChecked(i == c)
		}
	}
	a.scheduleSearch()
	a.search.SetFocus()
}

// updateFilterButtons zeigt die Trefferzahl je Kategorie auf den Knöpfen.
func (a *App) updateFilterButtons(counts *[NumCats]int) {
	for c, b := range a.filterBtns {
		if b == nil {
			continue
		}
		text := CatNames[c]
		if counts != nil {
			text += " (" + thousands(int64(counts[c])) + ")"
		}
		b.SetText(text)
		b.SetChecked(c == a.cfg.Filter)
	}
}

// ---------- Aktionen ----------

func (a *App) selectedPaths() []string {
	var out []string
	for _, i := range a.tv.SelectedIndexes() {
		if i < len(a.model.rows) {
			out = append(out, a.model.ix.Path(&a.model.ix.Entries[a.model.rows[i]]))
		}
	}
	if len(out) == 0 {
		if i := a.tv.CurrentIndex(); i >= 0 && i < len(a.model.rows) {
			out = append(out, a.model.ix.Path(&a.model.ix.Entries[a.model.rows[i]]))
		}
	}
	return out
}

func (a *App) openSelected() {
	paths := a.selectedPaths()
	if len(paths) > 10 {
		if walk.MsgBox(a.mw, brandProduct, fmt.Sprintf("%d Dateien öffnen?", len(paths)),
			walk.MsgBoxYesNo|walk.MsgBoxIconQuestion) != walk.DlgCmdYes {
			return
		}
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err != nil {
			walk.MsgBox(a.mw, brandProduct, "Nicht mehr vorhanden oder kein Zugriff:\n"+p+
				"\n\nTipp: Index aktualisieren (F5).", walk.MsgBoxIconWarning)
			continue
		}
		win.ShellExecute(a.mw.Handle(), syscall.StringToUTF16Ptr("open"),
			syscall.StringToUTF16Ptr(p), nil, nil, win.SW_SHOWNORMAL)
	}
}

func (a *App) showInFolder() {
	paths := a.selectedPaths()
	if len(paths) == 0 {
		return
	}
	cmd := exec.Command("explorer.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer.exe /select,"` + paths[0] + `"`}
	cmd.Start()
}

func (a *App) copyText(full bool) {
	paths := a.selectedPaths()
	if !full {
		for i, p := range paths {
			paths[i] = p[strings.LastIndexAny(p, `\/`)+1:]
		}
	}
	if len(paths) > 0 {
		walk.Clipboard().SetText(strings.Join(paths, "\r\n"))
		a.setStatus(fmt.Sprintf("%d %s in die Zwischenablage kopiert.", len(paths), map[bool]string{true: "Pfad(e)", false: "Name(n)"}[full]))
	}
}

// copyFiles legt die Dateien wie im Explorer in die Zwischenablage (Einfügen mit Strg+V).
func (a *App) copyFiles() {
	paths := a.selectedPaths()
	if len(paths) == 0 {
		return
	}
	if err := CopyFilesToClipboard(uintptr(a.mw.Handle()), paths); err != nil {
		a.setStatus("Kopieren fehlgeschlagen: " + err.Error())
		return
	}
	a.setStatus(fmt.Sprintf("%d Datei(en) kopiert – mit Strg+V im Explorer, in E-Mails, Google Drive usw. einfügen.", len(paths)))
}

func (a *App) setupDrag() {
	a.tv.MouseDown().Attach(func(x, y int, b walk.MouseButton) {
		a.dragArmed = b == walk.LeftButton
		a.dragX, a.dragY = x, y
	})
	a.tv.MouseUp().Attach(func(x, y int, b walk.MouseButton) { a.dragArmed = false })
	a.tv.MouseMove().Attach(func(x, y int, b walk.MouseButton) {
		if !a.dragArmed || b&walk.LeftButton == 0 {
			return
		}
		dx, dy := x-a.dragX, y-a.dragY
		if dx*dx+dy*dy < 25 {
			return
		}
		a.dragArmed = false
		paths := a.selectedPaths()
		if len(paths) == 0 {
			return
		}
		if err := DragFiles(uintptr(a.mw.Handle()), paths); err != nil {
			a.setStatus("Ziehen nicht möglich: " + err.Error())
		}
	})
}

func (a *App) rebuildCopyMenu() {
	if a.copyMenu == nil {
		return
	}
	acts := a.copyMenu.Actions()
	acts.Clear()
	add := func(text string, f func()) {
		act := walk.NewAction()
		act.SetText(text)
		act.Triggered().Attach(f)
		acts.Add(act)
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
	for _, t := range targets {
		t := t
		label := strings.ReplaceAll(t, "&", "&&")
		if strings.EqualFold(t, a.gdrive) {
			label = "Google Drive  (" + label + ")"
		}
		add(label, func() { a.copyTo(t) })
	}
	if len(targets) > 0 {
		acts.Add(walk.NewSeparatorAction())
	}
	add("Ordner auswählen …", func() {
		fd := &walk.FileDialog{Title: "Wohin sollen die Dateien kopiert werden?"}
		if ok, _ := fd.ShowBrowseFolder(a.mw); ok && fd.FilePath != "" {
			a.copyTo(fd.FilePath)
		}
	})
}

func (a *App) copyTo(target string) {
	paths := a.selectedPaths()
	if len(paths) == 0 {
		return
	}
	a.cfg.addCopyTarget(target)
	a.cfg.Save()
	a.rebuildCopyMenu()
	a.setStatus(fmt.Sprintf("Kopiere %d Element(e) nach %s …", len(paths), target))
	go func() {
		err := CopyFilesTo(paths, target)
		a.mw.Synchronize(func() {
			if err != nil {
				a.setStatus(err.Error())
			} else {
				a.setStatus(fmt.Sprintf("%d Element(e) nach %s kopiert.", len(paths), target))
			}
		})
	}()
}
